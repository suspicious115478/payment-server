require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("SERVER RUNNING");
});

app.post("/create-qr", async (req, res) => {

  try {

    const { restaurantId, amount, orderId } = req.body;

    const snap = await db
      .collection("restaurants")
      .doc(restaurantId)
      .collection("settings")
      .doc("razorpay")
      .get();

    if (!snap.exists) {
      return res.status(404).json({
        error: "Razorpay settings not found"
      });
    }

    const data = snap.data();

    const razorpay = new Razorpay({
      key_id: data.keyId,
      key_secret: data.keySecret
    });

    const qr = await razorpay.qrCode.create({
      type: "upi_qr",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: Math.round(amount * 100),
      description: "Kiosk Order",
      notes: {
        orderId: orderId
      }
    });

    await db.collection("restaurants")
      .doc(restaurantId)
      .collection("orders")
      .doc(orderId)
      .update({
        qrId: qr.id,
        paymentStatus: "PENDING"
      });

    res.json({
      qrImage: qr.image_url,
      qrId: qr.id
    });

  } catch (e) {

    console.log(e);

    res.status(500).json({
      error: e.message
    });
  }

});

app.post("/webhook", async (req, res) => {

  try {

    const event = req.body.event;

    if (event === "payment.captured") {

      const payment = req.body.payload.payment.entity;

      const notes = payment.notes || {};

      const orderId = notes.orderId;

      const restaurants = await db.collection("restaurants").get();

      for (const doc of restaurants.docs) {

        const orderRef = db.collection("restaurants")
          .doc(doc.id)
          .collection("orders")
          .doc(orderId);

        const orderSnap = await orderRef.get();

        if (orderSnap.exists) {

          await orderRef.update({
            paymentStatus: "SUCCESS",
            paymentId: payment.id,
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          });

          break;
        }
      }
    }

    res.status(200).send("OK");

  } catch (e) {

    console.log(e);

    res.status(500).send(e.message);
  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
