const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();
const messaging = admin.messaging();

function safeStringify(value, options = {}) {
  const { maxStringLength = 500, pretty = false } = options;
  try {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);
        }
        if (typeof val === "string" && val.length > maxStringLength) {
          return `${val.slice(0, maxStringLength)}…`;
        }
        return val;
      },
      pretty ? 2 : undefined
    );
  } catch (error) {
    return "[Unserializable payload]";
  }
}

exports.notifyOwner = functions.https.onCall(async (request, legacyContext) => {
  const isCallableRequest =
    request &&
    typeof request === "object" &&
    Object.prototype.hasOwnProperty.call(request, "data");

  const payload =
    isCallableRequest && typeof request.data === "object" ? request.data : request;

  const authContext = isCallableRequest
    ? request.auth || null
    : legacyContext?.auth || null;

const {
    qrId = "",
    userId = "",
    fcmToken = "",
    title = "",
    body = "",
    metadata = {},
  } = (payload && typeof payload === "object" ? payload : {}) || {};

  if (!qrId || !userId || !fcmToken || !title || !body) {
    const missingFields = [
      !qrId && "qrId",
      !userId && "userId",
      !fcmToken && "fcmToken",
      !title && "title",
      !body && "body",
    ].filter(Boolean);
    functions.logger.warn("notifyOwner called with missing fields", {
      missingFields,
      payload: safeStringify(payload, { pretty: true }),
      auth: authContext ? { uid: authContext.uid || null } : null,
    });
    throw new functions.https.HttpsError(
      "invalid-argument",
      `Missing required fields: ${missingFields.join(", ")}`
    );
  }

  const cleanedMetadata = {};
  if (metadata && typeof metadata === "object") {
    Object.entries(metadata).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      const strValue = String(value).trim();
      if (strValue.length) {
        cleanedMetadata[key] = strValue;
      }
    });
  }

  try {
    const dataPayload = {
      qrId,
      userId,
      source: "avahanaa-web",
      ...Object.entries(cleanedMetadata).reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {}),
    };

    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: dataPayload,
      android: {
        priority: "high",
        notification: {
          channelId: "congestion_free_channel",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
          sound: "default",
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
          },
        },
      },
    };

    await messaging.send(message);

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
