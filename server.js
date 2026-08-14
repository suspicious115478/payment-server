require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

/* AWS S3 */
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const S3_BUCKET = process.env.S3_BUCKET_NAME;

/* FIREBASE */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

/* HOME */
app.get("/", (req, res) => {
  res.send("SERVER RUNNING");
});

/* CREATE QR */
app.post("/create-qr", async (req, res) => {
  try {
    const { restaurantId, amount, orderId } = req.body;

    if (!restaurantId || !amount || !orderId) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    /* GET RAZORPAY SETTINGS */
    const snap = await db
      .collection("restaurants")
      .doc(restaurantId)
      .collection("settings")
      .doc("razorpay")
      .get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Razorpay settings not found" });
    }

    const data = snap.data();
    const razorpay = new Razorpay({
      key_id: data.keyId,
      key_secret: data.keySecret
    });

    /* CREATE QR — close_by = 30 min baad expire */
    const closeBy = Math.floor(Date.now() / 1000) + 1800;

    const qr = await razorpay.qrCode.create({
      type: "upi_qr",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: Math.round(amount * 100),
      description: "Kiosk Order",
      close_by: closeBy,
      notes: {
        orderId,
        restaurantId
      }
    });

    console.log("QR CREATED:", qr.id);
    console.log("QR IMAGE URL:", qr.image_url); // ✅ Yeh print hona chahiye

    /* UPDATE ORDER with qrId */
    await db
      .collection("restaurants")
      .doc(restaurantId)
      .collection("orders")
      .doc(orderId)
      .update({
        qrId: qr.id,
        paymentStatus: "PENDING"
      });

    /* ✅ FIX: qr.image_url bhejo, qr.close_by nahi */
    res.json({
      success: true,
      qrImage: qr.image_url,
      qrId: qr.id
    });

  } catch (e) {
    console.log("CREATE QR ERROR:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* WEBHOOK */
/* UPLOAD AD BANNER SLOT (restaurantId ke UID-based folder me, slot 1-6) */
app.post("/upload-banner-slot", async (req, res) => {
  try {
    const { restaurantId, slot, base64 } = req.body;
    if (!restaurantId || !slot || !base64) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }
    if (slot < 1 || slot > 6) {
      return res.status(400).json({ success: false, error: "Invalid slot" });
    }

    const matches = base64.match(/^data:(image\/\w+);base64,(.+)$/);
    const contentType = matches ? matches[1] : "image/jpeg";
    const rawBase64 = matches ? matches[2] : base64;
    const buffer = Buffer.from(rawBase64, "base64");

    const ext = contentType.split("/")[1] || "jpg";
    const key = `restaurants/${restaurantId}/ad-banners/banner_${slot}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read"
    }));

    const url = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    res.json({ success: true, url, slot });
  } catch (e) {
    console.log("UPLOAD BANNER ERROR:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* DELETE AD BANNER SLOT */
app.post("/delete-banner-slot", async (req, res) => {
  try {
    const { restaurantId, slot, ext } = req.body;
    if (!restaurantId || !slot) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    const key = `restaurants/${restaurantId}/ad-banners/banner_${slot}.${ext || "jpg"}`;

    await s3.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    }));

    res.json({ success: true });
  } catch (e) {
    console.log("DELETE BANNER ERROR:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* WEBHOOK */
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.event;
    console.log("WEBHOOK EVENT:", event);

    if (event === "payment.captured") {
      const payment = req.body.payload.payment.entity;
      const notes = payment.notes || {};
      const orderId = notes.orderId;
      const restaurantId = notes.restaurantId;

      if (!orderId || !restaurantId) {
        return res.status(400).send("Missing notes");
      }

      await db
        .collection("restaurants")
        .doc(restaurantId)
        .collection("orders")
        .doc(orderId)
        .update({
          paymentStatus: "SUCCESS",
          paymentId: payment.id,
          paymentAmount: payment.amount / 100,
          paidAt: admin.firestore.FieldValue.serverTimestamp()
        });

      console.log("PAYMENT SUCCESS:", orderId);
    }

    res.status(200).send("OK");

  } catch (e) {
    console.log("WEBHOOK ERROR:", e);
    res.status(500).send(e.message);
  }
});

/* START SERVER */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
