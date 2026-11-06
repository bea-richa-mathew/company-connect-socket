
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.js";

const activeCalls = new Map();
const CALL_TIMEOUT_MS = 45_000;

const ALLOWED_REACTIONS = new Set([
  "👍",
  "❤️",
  "😂",
  "👏",
  "🎉",
  "✋",
  "😊",
  "🔥",
]);

const room = (id) => `user:${String(id)}`;

function emitTo(io, userId, event, payload) {
  io.to(room(userId)).emit(event, payload);
}

function respond(callback, data) {
  if (typeof callback === "function") {
    callback(data);
  }
}

function removeCall(callId) {
  const call = activeCalls.get(String(callId));

  if (!call) return null;

  if (call.timer) {
    clearTimeout(call.timer);
  }

  activeCalls.delete(String(callId));

  return call;
}

function notifyEnd(io, call, reason) {
  for (const id of [call.callerId, call.receiverId]) {
    emitTo(io, id, "call:ended", {
      callId: call.callId,
      reason,
    });
  }
}

function isParticipant(call, userId) {
  return (
    call.callerId === userId ||
    call.receiverId === userId
  );
}

function otherParticipant(call, userId) {
  return call.callerId === userId
    ? call.receiverId
    : call.callerId;
}

function acceptedCall(call, userId) {
  return Boolean(
    call &&
      call.status === "accepted" &&
      isParticipant(call, userId)
  );
}

function clearRecordingConsent(call) {
  call.recordingRequester = null;
  call.recordingConsent = null;
  call.recordingActive = false;
}

export function registerCallHandlers(io, socket) {
  const me = String(socket.data.user.id);
  const myName =
    socket.data.user.name || "Team member";

  // ========================================
  // START CALL
  // ========================================

  socket.on("call:start", async (payload, callback) => {
    try {
      const { conversationId, type } = payload || {};

      if (!["audio", "video"].includes(type)) {
        return respond(callback, {
          success: false,
          message: "Invalid call type",
        });
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return respond(callback, {
          success: false,
          message: "Invalid conversation",
        });
      }

      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: me,
      }).lean();

      if (
        !conversation ||
        conversation.participants.length !== 2
      ) {
        return respond(callback, {
          success: false,
          message: "Conversation unavailable",
        });
      }

      const receiverId = conversation.participants
        .map(String)
        .find((id) => id !== me);

      if (!receiverId) {
        return respond(callback, {
          success: false,
          message: "Receiver unavailable",
        });
      }

      const receiverSockets = await io
        .in(room(receiverId))
        .fetchSockets();

      if (!receiverSockets.length) {
        return respond(callback, {
          success: false,
          message: "The other person is offline",
        });
      }

      const busy = [...activeCalls.values()].some(
        (call) =>
          isParticipant(call, me) ||
          isParticipant(call, receiverId)
      );

      if (busy) {
        return respond(callback, {
          success: false,
          message:
            "One of the users is already in a call",
        });
      }

      const callId = randomUUID();

      const call = {
        callId,
        conversationId: String(conversationId),
        callerId: me,
        receiverId,
        type,
        status: "ringing",
        timer: null,

        // Recording permission state
        recordingRequester: null,
        recordingConsent: null,
        recordingActive: false,
      };

      activeCalls.set(callId, call);

      call.timer = setTimeout(() => {
        const expired = removeCall(callId);

        if (expired) {
          notifyEnd(io, expired, "No answer");
        }
      }, CALL_TIMEOUT_MS);

      emitTo(io, receiverId, "call:incoming", {
        callId,
        conversationId: call.conversationId,
        callerId: me,
        callerName: myName,
        type,
      });

      console.log(
        `Incoming ${type} call: ${me} -> ${receiverId}`
      );

      respond(callback, {
        success: true,
        data: { callId },
      });
    } catch (error) {
      console.error("call:start error:", error);

      respond(callback, {
        success: false,
        message: "Unable to start call",
      });
    }
  });

  // ========================================
  // ACCEPT CALL
  // ========================================

  socket.on("call:accept", (payload, callback) => {
    const call = activeCalls.get(
      String(payload?.callId)
    );

    if (
      !call ||
      call.receiverId !== me ||
      call.status !== "ringing"
    ) {
      return respond(callback, {
        success: false,
        message: "Call unavailable",
      });
    }

    call.status = "accepted";

    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }

    emitTo(io, call.callerId, "call:accepted", {
      callId: call.callId,
    });

    respond(callback, {
      success: true,
    });
  });

  // ========================================
  // REJECT CALL
  // ========================================

  socket.on("call:reject", (payload) => {
    const call = activeCalls.get(
      String(payload?.callId)
    );

    if (
      !call ||
      call.receiverId !== me ||
      call.status !== "ringing"
    ) {
      return;
    }

    removeCall(call.callId);
    notifyEnd(io, call, "Call rejected");
  });

  // ========================================
  // WEBRTC SIGNALING
  // ========================================

  socket.on("call:signal", (payload) => {
    const call = activeCalls.get(
      String(payload?.callId)
    );

    if (!acceptedCall(call, me)) {
      return;
    }

    const signal = payload?.signal;

    if (
      !signal ||
      !["offer", "answer", "candidate"].includes(
        signal.type
      )
    ) {
      return;
    }

    emitTo(
      io,
      otherParticipant(call, me),
      "call:signal",
      {
        callId: call.callId,
        signal,
      }
    );
  });

  // ========================================
  // REQUEST RECORDING PERMISSION
  // ========================================

  socket.on(
    "call:record-request",
    (payload, callback) => {
      const call = activeCalls.get(
        String(payload?.callId)
      );

      if (!acceptedCall(call, me)) {
        return respond(callback, {
          success: false,
          message: "Call unavailable",
        });
      }

      if (call.recordingActive) {
        return respond(callback, {
          success: false,
          message: "Recording is already active",
        });
      }

      if (call.recordingRequester) {
        return respond(callback, {
          success: false,
          message:
            "A recording permission request is pending",
        });
      }

      call.recordingRequester = me;
      call.recordingConsent = null;

      emitTo(
        io,
        otherParticipant(call, me),
        "call:record-request",
        {
          callId: call.callId,
          requesterId: me,
          requesterName: myName,
        }
      );

      respond(callback, {
        success: true,
      });
    }
  );

  // ========================================
  // RESPOND TO RECORDING PERMISSION
  // ========================================

  socket.on(
    "call:record-response",
    (payload, callback) => {
      const call = activeCalls.get(
        String(payload?.callId)
      );

      if (!acceptedCall(call, me)) {
        return respond(callback, {
          success: false,
          message: "Call unavailable",
        });
      }

      const requesterId = call.recordingRequester;

      if (
        !requesterId ||
        requesterId === me ||
        otherParticipant(call, me) !== requesterId
      ) {
        return respond(callback, {
          success: false,
          message: "No valid permission request",
        });
      }

      const approved = payload?.approved === true;

      call.recordingConsent = approved
        ? requesterId
        : null;

      call.recordingRequester = null;

      emitTo(
        io,
        requesterId,
        "call:record-response",
        {
          callId: call.callId,
          approved,
        }
      );

      respond(callback, {
        success: true,
      });
    }
  );

  // ========================================
  // RECORDING STATUS
  // ========================================

  socket.on(
    "call:recording",
    (payload, callback) => {
      const call = activeCalls.get(
        String(payload?.callId)
      );

      if (!acceptedCall(call, me)) {
        return respond(callback, {
          success: false,
          message: "Call unavailable",
        });
      }

      const recording = payload?.recording === true;

      if (recording) {
        if (call.recordingConsent !== me) {
          return respond(callback, {
            success: false,
            message:
              "Recording requires participant consent",
          });
        }

        if (call.recordingActive) {
          return respond(callback, {
            success: false,
            message: "Recording already active",
          });
        }

        call.recordingActive = true;
      } else {
        if (
          !call.recordingActive &&
          !call.recordingConsent
        ) {
          return respond(callback, {
            success: true,
          });
        }

        // Either participant may request that
        // recording stop or consent be withdrawn.
        clearRecordingConsent(call);
      }

      emitTo(
        io,
        otherParticipant(call, me),
        "call:recording",
        {
          callId: call.callId,
          recording,
        }
      );

      respond(callback, {
        success: true,
      });
    }
  );

  // ========================================
  // RECORDING CONSENT WITHDRAWAL
  // ========================================

  socket.on("call:record-revoke", (payload) => {
    const call = activeCalls.get(
      String(payload?.callId)
    );

    if (!acceptedCall(call, me)) {
      return;
    }

    clearRecordingConsent(call);

    for (const id of [
      call.callerId,
      call.receiverId,
    ]) {
      emitTo(io, id, "call:recording", {
        callId: call.callId,
        recording: false,
        reason: "Recording consent withdrawn",
      });
    }
  });

  // ========================================
  // LIVE EMOJI REACTIONS
  // ========================================

  socket.on("call:reaction", (payload) => {
    const call = activeCalls.get(
      String(payload?.callId)
    );

    if (!acceptedCall(call, me)) {
      return;
    }

    const emoji = payload?.emoji;

    if (
      typeof emoji !== "string" ||
      !ALLOWED_REACTIONS.has(emoji)
    ) {
      return;
    }

    emitTo(
      io,
      otherParticipant(call, me),
      "call:reaction",
      {
        callId: call.callId,
        emoji,
        sender: myName,
        senderId: me,
        timestamp: Date.now(),
      }
    );
  });

  // ========================================
  // END CALL
  // ========================================

  socket.on("call:end", (payload) => {
    const call = activeCalls.get(
      String(payload?.callId)
    );

    if (!call || !isParticipant(call, me)) {
      return;
    }

    removeCall(call.callId);
    notifyEnd(io, call, "Call ended");
  });

  // ========================================
  // DISCONNECT
  // ========================================

  socket.on("disconnect", async () => {
    try {
      // The user may have another browser tab.
      const remaining = await io
        .in(room(me))
        .fetchSockets();

      if (remaining.length) return;

      for (const call of [
        ...activeCalls.values(),
      ]) {
        if (!isParticipant(call, me)) {
          continue;
        }

        removeCall(call.callId);

        notifyEnd(
          io,
          call,
          "Participant disconnected"
        );
      }
    } catch (error) {
      console.error(
        "Call disconnect cleanup error:",
        error
      );
    }
  });
}
