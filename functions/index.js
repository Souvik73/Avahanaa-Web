const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();
const messaging = admin.messaging();

function buildClientFirebaseConfig() {
  const runtimeConfig = functions.config() || {};
  const clientConfig = runtimeConfig.client || runtimeConfig.firebase || {};
  const config = {
    apiKey:
      process.env.FIREBASE_API_KEY ||
      clientConfig.apiKey ||
      clientConfig.api_key,
    authDomain:
      process.env.FIREBASE_AUTH_DOMAIN ||
      clientConfig.authDomain ||
      clientConfig.auth_domain,
    projectId:
      process.env.FIREBASE_PROJECT_ID ||
      clientConfig.projectId ||
      clientConfig.project_id,
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ||
      clientConfig.storageBucket ||
      clientConfig.storage_bucket,
    messagingSenderId:
      process.env.FIREBASE_MESSAGING_SENDER_ID ||
      clientConfig.messagingSenderId ||
      clientConfig.messaging_sender_id,
    appId:
      process.env.FIREBASE_APP_ID ||
      clientConfig.appId ||
      clientConfig.app_id,
    measurementId:
      process.env.FIREBASE_MEASUREMENT_ID ||
      clientConfig.measurementId ||
      clientConfig.measurement_id,
  };

  const required = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
  ];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(
      `Missing Firebase client config env vars: ${missing.join(", ")}`
    );
  }
  return config;
}

exports.getFirebaseClientConfig = functions.https.onRequest((req, res) => {
  res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  try {
    const config = buildClientFirebaseConfig();
    res.status(200).json(config);
  } catch (error) {
    functions.logger.error("getFirebaseClientConfig failure", error);
    res.status(500).json({ error: "Firebase config is not available." });
  }
});

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
