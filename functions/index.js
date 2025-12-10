const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();
const messaging = admin.messaging();
const RATE_LIMIT_CONFIG = {
  perOrigin: {
    windowMs: 60 * 1000,
    max: 3,
    message:
      "Too many alerts were sent from this browser in a short time. Please wait a minute and try again.",
    scope: "origin",
  },
  perQr: {
    windowMs: 60 * 1000,
    max: 8,
    message:
      "This vehicle is receiving many alerts right now. Please wait a minute before trying again.",
    scope: "qr",
  },
};
const RATE_LIMIT_COLLECTION = "notificationRateLimits";

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

function getHeader(rawRequest, name) {
  if (!rawRequest) return "";
  if (typeof rawRequest.get === "function") {
    return rawRequest.get(name) || "";
  }
  const headerKey = Object.keys(rawRequest.headers || {}).find(
    (key) => key.toLowerCase() === name.toLowerCase()
  );
  return headerKey ? rawRequest.headers[headerKey] || "" : "";
}

function getRequesterFingerprint(rawRequest) {
  if (!rawRequest) {
    return { fingerprint: "anonymous", ip: "unknown" };
  }
  const forwardedFor = getHeader(rawRequest, "x-forwarded-for");
  const ip =
    (forwardedFor && forwardedFor.split(",")[0].trim()) ||
    rawRequest.ip ||
    rawRequest.connection?.remoteAddress ||
    "unknown";
  const userAgent = getHeader(rawRequest, "user-agent") || "unknown";
  const rawIdentity = `${ip}|${userAgent}`;
  const fingerprint = crypto
    .createHash("sha256")
    .update(rawIdentity)
    .digest("hex")
    .slice(0, 32);
  return { fingerprint, ip };
}

async function enforceRateLimits({ qrId, requesterFingerprint }) {
  if (!qrId) return;

  const nowMs = Date.now();
  const nowTimestamp = admin.firestore.Timestamp.fromMillis(nowMs);
  const limitsRef = firestore.collection(RATE_LIMIT_COLLECTION);
  const perOriginRef = limitsRef.doc(`qr:${qrId}:origin:${requesterFingerprint}`);
  const perQrRef = limitsRef.doc(`qr:${qrId}:global`);

  await firestore.runTransaction(async (txn) => {
    const checks = [
      { ref: perOriginRef, config: RATE_LIMIT_CONFIG.perOrigin },
      { ref: perQrRef, config: RATE_LIMIT_CONFIG.perQr },
    ];

    const snapshots = await Promise.all(
      checks.map(({ ref }) => txn.get(ref))
    );

    const updates = [];

    checks.forEach(({ ref, config }, index) => {
      const snap = snapshots[index];
      const windowStartMs = snap.exists && snap.get("windowStart")
        ? snap.get("windowStart").toMillis()
        : nowMs;
      const elapsedMs = nowMs - windowStartMs;
      const count = snap.exists && typeof snap.get("count") === "number" ? snap.get("count") : 0;
      const nextCount = elapsedMs > config.windowMs ? 1 : count + 1;

      if (nextCount > config.max) {
        const retryAfterSeconds = Math.max(
          5,
          Math.ceil((config.windowMs - elapsedMs) / 1000)
        );
        throw new functions.https.HttpsError(
          "resource-exhausted",
          config.message,
          {
            message: config.message,
            retryAfterSeconds,
            scope: config.scope,
          }
        );
      }

      const windowStart = elapsedMs > config.windowMs ? nowMs : windowStartMs;
      updates.push({
        ref,
        data: {
          count: nextCount,
          windowStart: admin.firestore.Timestamp.fromMillis(windowStart),
          updatedAt: nowTimestamp,
          scope: config.scope,
        },
      });
    });

    updates.forEach(({ ref, data }) => {
      txn.set(ref, data, { merge: true });
    });
  });
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
  const rawRequest = isCallableRequest
    ? request.rawRequest || legacyContext?.rawRequest || null
    : legacyContext?.rawRequest || null;
  const { fingerprint: requesterFingerprint } =
    getRequesterFingerprint(rawRequest);

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

    await enforceRateLimits({ qrId, requesterFingerprint });

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
    const isInvalidToken =
      error?.code === "messaging/registration-token-not-registered" ||
      error?.errorInfo?.code === "messaging/registration-token-not-registered";

    if (isInvalidToken) {
      functions.logger.warn("Invalid FCM token, deleting from user profile", {
        userId,
        qrId,
        fcmToken,
        error: error?.message,
      });
      if (userId) {
        try {
          await firestore.collection("users").doc(userId).set(
            {
              fcmToken: admin.firestore.FieldValue.delete(),
              fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch (tokenErr) {
          functions.logger.warn("Failed clearing invalid token", {
            userId,
            tokenErr: tokenErr?.message,
          });
        }
      }
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The notification token for this user is no longer valid. Ask them to open the app to refresh it."
      );
    }

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    console.error("notifyOwner error:", error);
    throw new functions.https.HttpsError(
      "internal",
      error.message || "Failed to deliver notification."
    );
  }
});
