require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
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

/* ───────────── E-RECEIPT ───────────── */
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 din
const RECEIPT_BASE_URL = (process.env.RECEIPT_BASE_URL || "https://payment-server-1zt6.onrender.com").trim();
const TOKEN_RE = /^[a-f0-9]{48}$/;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "Rs." + (Number(n) || 0).toFixed(2);

function payInfo(status) {
  if (status === "SUCCESS") return { method: "UPI", label: "Paid" };
  if (status === "PAYMENT_AT_COUNTER") return { method: "Pay at Counter", label: "Payment due at counter" };
  return { method: "-", label: status || "Pending" };
}

async function loadReceipt(token) {
  if (!TOKEN_RE.test(token || "")) return null;
  const r = await db.collection("receipts").doc(token).get();
  if (!r.exists) return null;
  const { restaurantId, orderId, expiresAt } = r.data();
  if (Date.now() > expiresAt) return null;
  const [o, rest] = await Promise.all([
    db.collection("restaurants").doc(restaurantId).collection("orders").doc(orderId).get(),
    db.collection("restaurants").doc(restaurantId).get()
  ]);
  if (!o.exists) return null;
  const order = o.data();
  const restaurant = rest.exists ? rest.data() : {};
  const created = order.createdAt && order.createdAt.toDate ? order.createdAt.toDate() : null;
  return { order, restaurant, orderId, created };
}

function extraRowsOf(order) {
  const extra = [];
  if (order.tax > 0) extra.push(["Tax", order.tax]);
  if (order.service > 0) extra.push(["Service", order.service]);
  if (order.packing > 0) extra.push(["Packing", order.packing]);
  if (order.other > 0) extra.push(["Other charges", order.other]);
  return extra;
}

/* Kiosk yahan se link maangta hai (sirf confirmed order ke liye) */
app.post("/create-receipt-link", async (req, res) => {
  try {
    const { restaurantId, orderId } = req.body;
    if (!restaurantId || !orderId)
      return res.status(400).json({ success: false, error: "Missing fields" });

    const ref = db.collection("restaurants").doc(restaurantId).collection("orders").doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Order not found" });

    const o = snap.data();
    if (!["SUCCESS", "PAYMENT_AT_COUNTER"].includes(o.paymentStatus))
      return res.status(409).json({ success: false, error: "Order not confirmed" });

    let token = o.receiptToken;
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      await db.collection("receipts").doc(token).set({
        restaurantId, orderId, expiresAt: Date.now() + RECEIPT_TTL_MS
      });
      await ref.update({ receiptToken: token });
    }
    res.json({ success: true, url: `${RECEIPT_BASE_URL}/r/${token}` });
  } catch (e) {
    console.log("CREATE RECEIPT LINK ERROR:", e.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* Customer ka mobile receipt page */
app.get("/r/:token", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  try {
    const d = await loadReceipt(req.params.token);
    if (!d) return res.status(404).send("<h3 style='font-family:sans-serif;text-align:center;margin-top:60px'>Receipt not found or expired.</h3>");
    const { order, restaurant, orderId, created } = d;
    const pay = payInfo(order.paymentStatus);
    const itemRows = (order.items || []).map(i =>
      `<tr><td>${esc(i.name)}<br><small>x${esc(i.qty)}</small></td><td class="r">${money(i.amount != null ? i.amount : i.price * i.qty)}</td></tr>`).join("");
    const extraRows = extraRowsOf(order).map(([l, v]) => `<tr><td>${l}</td><td class="r">${money(v)}</td></tr>`).join("");
    const logo = restaurant.logo ? `<img src="${esc(restaurant.logo)}" style="height:56px;border-radius:10px">` : "";

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt</title><style>
body{font-family:-apple-system,Segoe UI,sans-serif;background:#f4f1eb;margin:0;padding:16px;color:#18130d}
.c{max-width:420px;margin:auto;background:#fff;border-radius:16px;padding:22px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h2{margin:6px 0 2px;text-align:center}.m{color:#777;font-size:13px;text-align:center}
table{width:100%;border-collapse:collapse;margin-top:14px}td{padding:7px 0;border-bottom:1px dashed #ddd;font-size:14px}
.r{text-align:right}.t td{font-weight:700;font-size:16px;border-bottom:none}
.b{display:block;margin-top:18px;background:#c8831a;color:#fff;text-align:center;padding:14px;border-radius:12px;text-decoration:none;font-weight:600}
.s{margin-top:12px;text-align:center;font-size:13px;font-weight:600}
</style></head><body><div class="c">
<div style="text-align:center">${logo}</div>
<h2>${esc(restaurant.name || "Restaurant")}</h2>
<div class="m">${esc(restaurant.address || "")} ${esc(restaurant.phone || "")}</div>
<div class="m" style="margin-top:10px">Invoice #${esc(order.invoiceNumber)} · Token FG-${esc(order.tokenNumber)}<br>Order ${esc(orderId.slice(0,6).toUpperCase())} · ${created ? created.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}) : ""}<br>${esc(order.orderType || "")}</div>
<table>${itemRows}<tr><td>Subtotal</td><td class="r">${money(order.subtotal)}</td></tr>${extraRows}
<tr class="t"><td>Total</td><td class="r">${money(order.totalPrice)}</td></tr></table>
<div class="s">Payment: ${esc(pay.method)} - ${esc(pay.label)}</div>
${order.paymentId ? `<div class="m">Ref: ${esc(order.paymentId)}</div>` : ""}
<a class="b" href="/r/${esc(req.params.token)}/pdf">Download Receipt (PDF)</a>
</div></body></html>`);
  } catch (e) {
    console.log("RECEIPT PAGE ERROR:", e.message);
    res.status(500).send("Something went wrong.");
  }
});

/* PDF download */
app.get("/r/:token/pdf", async (req, res) => {
  try {
    const d = await loadReceipt(req.params.token);
    if (!d) return res.status(404).send("Receipt not found or expired.");
    const { order, restaurant, orderId, created } = d;
    const pay = payInfo(order.paymentStatus);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="receipt-${orderId.slice(0, 6)}.pdf"`,
      "Cache-Control": "no-store"
    });
    const pdf = new PDFDocument({ size: "A5", margin: 36 });
    pdf.pipe(res);
    pdf.fontSize(18).text(restaurant.name || "Restaurant", { align: "center" });
    pdf.fontSize(9).fillColor("#666")
       .text(`${restaurant.address || ""} ${restaurant.phone || ""}`.trim(), { align: "center" });
    pdf.moveDown().fillColor("#000").fontSize(10)
       .text(`Invoice #${order.invoiceNumber}   Token FG-${order.tokenNumber}`)
       .text(`Order ${orderId.slice(0, 6).toUpperCase()}   ${created ? created.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}`)
       .text(`Type: ${order.orderType || ""}`).moveDown();
    (order.items || []).forEach(i => {
      const y = pdf.y;
      pdf.text(`${i.name} x${i.qty}`, 36, y, { width: 240 });
      pdf.text(money(i.amount != null ? i.amount : i.price * i.qty), 280, y, { width: 80, align: "right" });
    });
    pdf.moveDown();
    const line = (l, v, bold) => {
      const y = pdf.y;
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").text(l, 36, y, { width: 240 });
      pdf.text(money(v), 280, y, { width: 80, align: "right" });
    };
    line("Subtotal", order.subtotal);
    extraRowsOf(order).forEach(([l, v]) => line(l, v));
    line("TOTAL", order.totalPrice, true);
    pdf.font("Helvetica").moveDown().text(`Payment: ${pay.method} - ${pay.label}`);
    if (order.paymentId) pdf.text(`Ref: ${order.paymentId}`);
    pdf.end();
  } catch (e) {
    console.log("RECEIPT PDF ERROR:", e.message);
    if (!res.headersSent) res.status(500).send("Something went wrong.");
  }
});

/* WEBHOOK */
app.post("/webhook", async (req, res) => {
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
      ContentType: contentType
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
