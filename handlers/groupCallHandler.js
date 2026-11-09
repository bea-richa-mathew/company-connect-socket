
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { AccessToken } from "livekit-server-sdk";
import Conversation from "../models/Conversation.js";

const activeGroupCalls = new Map();
const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1000;

const userRoom = (id) => `user:${String(id)}`;

function respond(callback, result) {
  if (typeof callback === "function") {
    callback(result);
  }
}

function failure(message) {
  return {
    success: false,
    message,
  };
}

function emitTo(io, userId, event, data) {
  io.to(userRoom(userId)).emit(event, data);
}

async function getGroup(conversationId, userId) {
  if (!mongoose.isValidObjectId(conversationId)) {
    return null;
  }

  return Conversation.findOne({
    _id: conversationId,
    type: "group",
    participants: userId,
  })
    .select("_id type name participants")
    .lean();
}

async function getAuthorizedCall(callId, userId) {
  const call = activeGroupCalls.get(String(callId));

  if (!call) return null;

  const conversation = await getGroup(
    call.conversationId,
    userId
  );

  return conversation ? { call, conversation } : null;
}

function notifyParticipants(io, call, event, data) {
  for (const participantId of call.participantIds) {
    emitTo(io, participantId, event, data);
  }
}

function clearCall(io, call, reason = "Call ended") {
  if (call.timer) {
    clearTimeout(call.timer);
  }

  activeGroupCalls.delete(call.callId);

  notifyParticipants(io, call, "group-call:ended", {
    callId: call.callId,
    conversationId: call.conversationId,
    reason,
  });
}

function publicCall(call) {
  return {
    callId: call.callId,
    conversationId: call.conversationId,
    callerId: call.callerId,
    callerName: call.callerName,
    type: call.type,
    roomName: call.roomName,
    participantIds: [...call.joined],
    startedAt: call.startedAt,
  };
}

async function createToken(call, userId, userName) {
  const {
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
  } = process.env;

  if (
    !LIVEKIT_URL ||
    !LIVEKIT_API_KEY ||
    !LIVEKIT_API_SECRET
  ) {
    throw new Error("LiveKit environment variables are missing");
  }

  const token = new AccessToken(
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    {
      identity: String(userId),
      name: String(userName || "Team member"),
      ttl: "2h",
    }
  );

  token.addGrant({
    roomJoin: true,
    room: call.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return {
    token: await token.toJwt(),
    serverUrl: LIVEKIT_URL,
    roomName: call.roomName,
    callId: call.callId,
    type: call.type,
  };
}

export function registerGroupCallHandlers(io, socket) {
  const me = String(socket.data.user.id);
  const myName = socket.data.user.name || "Team member";

  // -------------------------------------------
  // START GROUP AUDIO / VIDEO CALL
  // -------------------------------------------

  socket.on(
    "group-call:start",
    async (payload, callback) => {
      try {
        const { conversationId, type } = payload || {};

        if (!["audio", "video"].includes(type)) {
          return respond(
            callback,
            failure("Invalid call type")
          );
        }

        const conversation = await getGroup(
          conversationId,
          me
        );

        if (!conversation) {
          return respond(
            callback,
            failure("Group conversation unavailable")
          );
        }

        const existing = [...activeGroupCalls.values()]
          .find(
            (call) =>
              call.conversationId === String(conversationId)
          );

        if (existing) {
          return respond(
            callback,
            failure("A group call is already active")
          );
        }

        const callId = randomUUID();

        const call = {
          callId,
          conversationId: String(conversationId),
          callerId: me,
          callerName: myName,
          type,
          roomName: `group-${conversationId}-${callId}`,
          participantIds: conversation.participants.map(String),
          joined: new Set(),
          startedAt: new Date().toISOString(),
          timer: null,
        };

        activeGroupCalls.set(callId, call);

        call.timer = setTimeout(() => {
          if (activeGroupCalls.get(callId) === call) {
            clearCall(io, call, "Call duration expired");
          }
        }, MAX_CALL_DURATION_MS);

        for (const participantId of call.participantIds) {
          if (participantId === me) continue;

          emitTo(
            io,
            participantId,
            "group-call:incoming",
            publicCall(call)
          );
        }

        const credentials = await createToken(
          call,
          me,
          myName
        );

        call.joined.add(me);

        respond(callback, {
          success: true,
          data: {
            ...publicCall(call),
            ...credentials,
          },
        });

        notifyParticipants(
          io,
          call,
          "group-call:updated",
          publicCall(call)
        );
      } catch (error) {
        console.error("group-call:start:", error);

        respond(
          callback,
          failure("Unable to start group call")
        );
      }
    }
  );

  // -------------------------------------------
  // JOIN / ACCEPT GROUP CALL
  // -------------------------------------------

  socket.on(
    "group-call:join",
    async (payload, callback) => {
      try {
        const result = await getAuthorizedCall(
          payload?.callId,
          me
        );

        if (!result) {
          return respond(
            callback,
            failure("Call unavailable or access denied")
          );
        }

        const { call } = result;

        const credentials = await createToken(
          call,
          me,
          myName
        );

        call.joined.add(me);

        respond(callback, {
          success: true,
          data: {
            ...publicCall(call),
            ...credentials,
          },
        });

        notifyParticipants(
          io,
          call,
          "group-call:updated",
          publicCall(call)
        );
      } catch (error) {
        console.error("group-call:join:", error);

        respond(
          callback,
          failure("Unable to join group call")
        );
      }
    }
  );

  // -------------------------------------------
  // DECLINE INVITATION
  // -------------------------------------------

  socket.on(
    "group-call:reject",
    async (payload, callback) => {
      const result = await getAuthorizedCall(
        payload?.callId,
        me
      );

      if (!result) {
        return respond(
          callback,
          failure("Call unavailable")
        );
      }

      respond(callback, {
        success: true,
      });
    }
  );

  // -------------------------------------------
  // LEAVE GROUP CALL
  // -------------------------------------------

  socket.on(
    "group-call:leave",
    async (payload, callback) => {
      const result = await getAuthorizedCall(
        payload?.callId,
        me
      );

      if (!result) {
        return respond(
          callback,
          failure("Call unavailable")
        );
      }

      const { call } = result;

      call.joined.delete(me);

      respond(callback, {
        success: true,
      });

      if (call.joined.size === 0) {
        clearCall(io, call);
        return;
      }

      notifyParticipants(
        io,
        call,
        "group-call:updated",
        publicCall(call)
      );
    }
  );

  // -------------------------------------------
  // END GROUP CALL FOR EVERYONE
  // -------------------------------------------

  socket.on(
    "group-call:end",
    async (payload, callback) => {
      const result = await getAuthorizedCall(
        payload?.callId,
        me
      );

      if (!result) {
        return respond(
          callback,
          failure("Call unavailable")
        );
      }

      const { call } = result;

      if (call.callerId !== me) {
        return respond(
          callback,
          failure("Only the call creator can end this call")
        );
      }

      clearCall(io, call);

      respond(callback, {
        success: true,
      });
    }
  );

  // -------------------------------------------
  // CHECK ACTIVE GROUP CALL
  // -------------------------------------------

  socket.on(
    "group-call:active",
    async (payload, callback) => {
      const conversation = await getGroup(
        payload?.conversationId,
        me
      );

      if (!conversation) {
        return respond(
          callback,
          failure("Group unavailable")
        );
      }

      const call = [...activeGroupCalls.values()]
        .find(
          (item) =>
            item.conversationId ===
            String(conversation._id)
        );

      respond(callback, {
        success: true,
        data: call ? publicCall(call) : null,
      });
    }
  );

  // -------------------------------------------
  // DISCONNECT
  // -------------------------------------------

  socket.on("disconnect", async () => {
    try {
      const remainingSockets = await io
        .in(userRoom(me))
        .fetchSockets();

      if (remainingSockets.length) return;

      for (const call of activeGroupCalls.values()) {
        if (!call.joined.has(me)) continue;

        call.joined.delete(me);

        if (call.joined.size === 0) {
          clearCall(io, call, "All participants left");
        } else {
          notifyParticipants(
            io,
            call,
            "group-call:updated",
            publicCall(call)
          );
        }
      }
    } catch (error) {
      console.error(
        "Group call disconnect cleanup:",
        error
      );
    }
  });
}
