require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 4003; // Separate port for IG
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "zarea_verify_2025";
const RAW_MESSAGES_COLLECTION = "raw_messages";
const INSTA_SESSIONS_COLLECTION = "instagram_sessions";

let db;

// --- INITIALIZE FIREBASE ---
async function initializeFirebase() {
  try {
    const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!base64Key) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64");
    
    const serviceAccount = JSON.parse(Buffer.from(base64Key, "base64").toString("utf-8"));
    
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    db = admin.firestore();
    console.log("🔥 [Firebase] Instagram Backend Initialized");
  } catch (error) {
    console.error("❌ [Firebase] Init Error:", error.message);
    process.exit(1);
  }
}

// --- MESSAGE BUNDLING & SAVE ---
async function saveInstagramMessage(payload, userId) {
  const { sender, recipient, message, timestamp } = payload;
  const instagramBusinessId = recipient.id; // The IG account receiving the message
  const igsid = sender.id; // Instagram Scoped ID of the sender

  try {
    const rawMessagesRef = db.collection(RAW_MESSAGES_COLLECTION);

    // 8-second bundling logic
    const recentMessages = await rawMessagesRef
      .where("userId", "==", userId)
      .where("from", "==", igsid)
      .where("platform", "==", "instagram")
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    if (!recentMessages.empty) {
      const recentDoc = recentMessages.docs[0];
      const recentData = recentDoc.data();
      const now = Date.now();
      const docTime = recentData.timestamp.toMillis();

      if (recentData.processed === false && (now - docTime < 8000)) {
        const newBody = recentData.body + "\n" + message.text;
        await recentDoc.ref.update({
          body: newBody,
          timestamp: admin.firestore.Timestamp.now()
        });
        console.log(`📩 [${userId}] Bundled Instagram message into ${recentDoc.id.substring(0, 8)}`);
        return;
      }
    }

    // New message
    const messageData = {
      timestamp: admin.firestore.Timestamp.now(),
      userId,
      phoneNumber: igsid, // Using IGSID as the unique identifier
      from: igsid,
      to: instagramBusinessId,
      type: "chat",
      body: message.text,
      isGroup: false,
      platform: "instagram",
      wwebId: message.mid,
      processed: false,
      isLead: null,
      replyPending: false,
      autoReplyText: null,
    };

    const docRef = await rawMessagesRef.add(messageData);
    console.log(`📩 [${userId}] New Instagram message saved: ${docRef.id.substring(0, 8)}`);
  } catch (error) {
    console.error(`⚠️ [${userId}] Error saving Instagram message:`, error.message);
  }
}

// --- AI REPLY EXECUTOR ---
function startReplyListener() {
  console.log("🤖 [Executor] Listening for Instagram replies...");
  
  db.collection(RAW_MESSAGES_COLLECTION)
    .where("replyPending", "==", true)
    .where("platform", "==", "instagram")
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added" && change.type !== "modified") return;
        
        const doc = change.doc;
        const msg = doc.data();
        
        if (!msg.autoReplyText || !msg.from || !msg.userId) return;

        try {
          // Get Page Access Token from instagram_sessions
          const sessionSnap = await db.collection(INSTA_SESSIONS_COLLECTION).doc(msg.userId).get();
          if (!sessionSnap.exists) return;
          
          const { pageAccessToken } = sessionSnap.data();
          if (!pageAccessToken) return;

          // Send via Meta Graph API (Same endpoint as Facebook)
          const response = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: msg.from },
              message: { text: msg.autoReplyText }
            })
          });

          const result = await response.json();
          if (result.error) throw new Error(result.error.message);

          // Update message status
          await doc.ref.update({
            replyPending: false,
            replySentAt: admin.firestore.Timestamp.now()
          });

          console.log(`✅ [${msg.userId}] AI reply sent via Instagram IGSID ${msg.from}`);
        } catch (error) {
          console.error(`❌ [${msg.userId}] Instagram Reply Error:`, error.message);
        }
      });
    });
}

const app = express();
app.use(express.json());

// --- WEBHOOK VERIFICATION ---
app.get("/webhook", (req, res) => {
  console.log("🔍 [Webhook] Verification request received");
  console.log("Query Params:", JSON.stringify(req.query, null, 2));

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ [Webhook] Verified by Meta (Instagram)");
      // Meta expects the challenge to be returned as plain text
      return res.status(200).set('Content-Type', 'text/plain').send(challenge);
    } else {
      console.log("❌ [Webhook] Verification failed: Token mismatch or invalid mode");
      console.log(`Expected: ${VERIFY_TOKEN}, Received: ${token}`);
      return res.sendStatus(403);
    }
  }
  
  console.log("⚠️ [Webhook] Verification request missing parameters");
  res.status(400).send("Missing hub.mode or hub.verify_token");
});

// --- WEBHOOK EVENT HANDLER ---
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "instagram") {
    for (const entry of body.entry) {
      const igbaId = entry.id; // Instagram Business Account ID
      const webhookEvent = entry.messaging[0];

      if (webhookEvent.message && webhookEvent.message.text) {
        try {
          // Find userId for this Instagram account
          const sessionQuery = await db.collection(INSTA_SESSIONS_COLLECTION)
            .where("instagramBusinessId", "==", igbaId)
            .limit(1)
            .get();

          if (sessionQuery.empty) {
            console.log(`⚠️ [Webhook] No session found for IG ID ${igbaId}`);
            continue;
          }

          const userId = sessionQuery.docs[0].id;
          await saveInstagramMessage(webhookEvent, userId);
        } catch (error) {
          console.error("❌ [Webhook] Processing Error:", error.message);
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

app.get("/", (req, res) => {
  res.json({ status: "running", platform: "instagram" });
});

// --- BOOTSTRAP ---
(async () => {
  await initializeFirebase();
  startReplyListener();
  app.listen(PORT, () => {
    console.log(`\n🌍 [Server] Instagram Backend running on port ${PORT}`);
  });
})();
