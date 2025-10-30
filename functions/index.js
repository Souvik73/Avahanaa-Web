const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();
const messaging = admin.messaging();

exports.notifyOwner = functions.https.onCall(async (data, context) => {
  const {
    qrId = "",
    userId = "",
    fcmToken = "",
    title = "",
    body = "",
    metadata = {},
  } = data || {};

  if (!qrId || !userId || !fcmToken || !title || !body) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Missing qrId, userId, fcmToken, title, or body."
    );
  }

  const cleanedMetadata = {};
  if (metadata && typeof metadata === "object") {
    Object.entries(metadata).forEach(([key, value]) => {
      if (typeof value === "string" && value.trim().length) {
        cleanedMetadata[key] = value.trim();
      }
    });
  }

  try {
    await messaging.send({
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: {
        qrId,
        userId,
        source: "avahanaa-web",
        ...Object.entries(cleanedMetadata).reduce((acc, [key, value]) => {
          acc[key] = value;
          return acc;
        }, {}),
      },
      android: {
        priority: "high",
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    });

    await firestore.collection("notifications").add({
      qrCodeId: qrId,
      userId,
      reason: cleanedMetadata.reason || "other",
      message: cleanedMetadata.message || body,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "sent",
      read: false,
      readAt: null,
    });

    return { ok: true };
  } catch (error) {
    console.error("notifyOwner error:", error);
    throw new functions.https.HttpsError(
      "internal",
      error.message || "Failed to deliver notification."
    );
  }
});
