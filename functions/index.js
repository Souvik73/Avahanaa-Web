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
      `Missing required fields ${safeStringify(data, { pretty: true })}: ${missingFields.join(", ")}`
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
