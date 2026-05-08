require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

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
