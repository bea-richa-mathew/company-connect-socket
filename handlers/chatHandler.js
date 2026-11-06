import mongoose from "mongoose";

import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";

const validId = mongoose.isValidObjectId;

const asId = (value) => String(value);

const userRoom = (id) => `user:${id}`;
const chatRoom = (id) => `conversation:${id}`;

function reply(callback, result) {
  if (typeof callback === "function") {
    callback(result);
  }
}

function publicUser(user) {
  return {
    _id: asId(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    employeeId: user.employeeId,
    profileImage: user.profileImage,
  };
}

function publicMessage(message) {
  return {
    _id: asId(message._id),
    conversationId: asId(message.conversation),
    sender: asId(message.sender),
    text: message.text,
    readBy: (message.readBy || []).map(asId),
    createdAt: message.createdAt,
  };
}

async function findConversation(conversationId, userId) {
  if (!validId(conversationId)) return null;

  return Conversation.findOne({
    _id: conversationId,
    participants: userId,
  });
}

async function findContact(targetId, currentId) {
  if (
    !validId(targetId) ||
    asId(targetId) === asId(currentId)
  ) {
    return null;
  }

  return mongoose.connection
    .collection("users")
    .findOne({
      _id: new mongoose.Types.ObjectId(targetId),
      role: { $in: ["admin", "employee"] },
      isActive: true,
    });
}

function isOnline(io, userId) {
  return Boolean(
    io.sockets.adapter.rooms.get(
      userRoom(asId(userId))
    )?.size
  );
}

async function listSummaries(userId, io) {
  const conversations = await Conversation.find({
    participants: userId,
  })
    .sort({
      lastMessageAt: -1,
      updatedAt: -1,
    })
    .limit(200)
    .lean();

  const results = [];

  for (const conversation of conversations) {
    const otherIds = conversation.participants
      .filter((id) => asId(id) !== asId(userId));

    const people = await mongoose.connection
      .collection("users")
      .find(
        { _id: { $in: otherIds } },
        {
          projection: {
            name: 1,
            email: 1,
            role: 1,
            department: 1,
            employeeId: 1,
            profileImage: 1,
          },
        }
      )
      .toArray();

    const lastMessage = await Message.findOne({
      conversation: conversation._id,
    })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    const unreadCount =
      await Message.countDocuments({
        conversation: conversation._id,
        sender: { $ne: userId },
        readBy: {
          $ne: new mongoose.Types.ObjectId(userId),
        },
      });

    results.push({
      _id: asId(conversation._id),
      type: conversation.type,
      name: conversation.name,
      participants: people.map((person) => ({
        ...publicUser(person),
        online: isOnline(io, person._id),
      })),
      lastMessage: lastMessage
        ? publicMessage(lastMessage)
        : null,
      lastMessageAt: conversation.lastMessageAt,
      unreadCount,
      online: people.some((person) =>
        isOnline(io, person._id)
      ),
    });
  }

  return results;
}

async function publishSummaries(io, conversation) {
  for (const participantId of conversation.participants) {
    const id = asId(participantId);

    io.to(userRoom(id)).emit(
      "conversations:changed",
      await listSummaries(id, io)
    );
  }
}

export function registerChatHandlers(io, socket) {
  const currentUser = socket.data.user;

  socket.join(userRoom(currentUser.id));

  console.log(
    `${currentUser.name} connected to chat`
  );

  async function broadcastPresence() {
    const conversations = await Conversation.find({
      participants: currentUser.id,
    })
      .select("participants")
      .lean();

    const contacts = new Set();

    for (const conversation of conversations) {
      for (const participantId of conversation.participants) {
        const id = asId(participantId);

        if (id !== currentUser.id) {
          contacts.add(id);
        }
      }
    }

    for (const id of contacts) {
      io.to(userRoom(id)).emit(
        "presence:changed",
        {
          userId: currentUser.id,
          online: isOnline(io, currentUser.id),
        }
      );
    }
  }

  void broadcastPresence().catch(console.error);

  // CONTACT LIST
  socket.on("contacts:list", async (callback) => {
    try {
      const users = await mongoose.connection
        .collection("users")
        .find(
          {
            _id: {
              $ne: new mongoose.Types.ObjectId(
                currentUser.id
              ),
            },
            role: {
              $in: ["employee", "admin"],
            },
            isActive: true,
          },
          {
            projection: {
              name: 1,
              email: 1,
              role: 1,
              department: 1,
              employeeId: 1,
              profileImage: 1,
            },
          }
        )
        .sort({ name: 1 })
        .limit(200)
        .toArray();

      reply(callback, {
        success: true,
        data: users.map((user) => ({
          ...publicUser(user),
          online: isOnline(io, user._id),
        })),
      });
    } catch (error) {
      console.error("contacts:list", error);

      reply(callback, {
        success: false,
        message: "Unable to load contacts",
      });
    }
  });

  // CONVERSATION LIST
  socket.on("conversations:list", async (callback) => {
    try {
      const data = await listSummaries(
        currentUser.id,
        io
      );

      reply(callback, {
        success: true,
        data,
      });
    } catch (error) {
      console.error("conversations:list", error);

      reply(callback, {
        success: false,
        message: "Unable to load conversations",
      });
    }
  });

  // CREATE OR FIND DIRECT CONVERSATION
  socket.on(
    "conversation:create",
    async (payload, callback) => {
      try {
        const target = await findContact(
          payload?.userId,
          currentUser.id
        );

        if (!target) {
          return reply(callback, {
            success: false,
            message: "Contact unavailable",
          });
        }

        const participants = [
          currentUser.id,
          asId(target._id),
        ].sort();

        const directKey = participants.join(":");

        const conversation =
          await Conversation.findOneAndUpdate(
            { directKey },
            {
              $setOnInsert: {
                directKey,
                type: "direct",
                participants,
              },
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
            }
          );

        socket.join(
          chatRoom(asId(conversation._id))
        );

        reply(callback, {
          success: true,
          data: {
            conversationId: asId(
              conversation._id
            ),
          },
        });

        await publishSummaries(io, conversation);
      } catch (error) {
        console.error("conversation:create", error);

        reply(callback, {
          success: false,
          message: "Unable to start conversation",
        });
      }
    }
  );

  // JOIN CONVERSATION
  socket.on(
    "conversation:join",
    async (conversationId, callback) => {
      try {
        const conversation =
          await findConversation(
            conversationId,
            currentUser.id
          );

        if (!conversation) {
          return reply(callback, {
            success: false,
            message: "Access denied",
          });
        }

        socket.join(chatRoom(conversationId));

        reply(callback, {
          success: true,
        });
      } catch (error) {
        console.error("conversation:join", error);

        reply(callback, {
          success: false,
          message: "Unable to join conversation",
        });
      }
    }
  );

  socket.on("conversation:leave", (conversationId) => {
    if (validId(conversationId)) {
      socket.leave(chatRoom(conversationId));
    }
  });

  // SEND MESSAGE
  socket.on(
    "message:send",
    async (payload, callback) => {
      try {
        const text =
          typeof payload?.text === "string"
            ? payload.text.trim()
            : "";

        if (!text || text.length > 5000) {
          return reply(callback, {
            success: false,
            message:
              "Message must contain 1–5000 characters",
          });
        }

        const conversation =
          await findConversation(
            payload?.conversationId,
            currentUser.id
          );

        if (!conversation) {
          return reply(callback, {
            success: false,
            message: "Access denied",
          });
        }

        const message = await Message.create({
          conversation: conversation._id,
          sender: currentUser.id,
          text,
          readBy: [currentUser.id],
        });

        conversation.lastMessageAt =
          message.createdAt;

        await conversation.save();

        const data = publicMessage(message);

        for (const participantId of
          conversation.participants) {
          io.to(
            userRoom(asId(participantId))
          ).emit("message:new", data);
        }

        reply(callback, {
          success: true,
          data,
        });

        await publishSummaries(io, conversation);
      } catch (error) {
        console.error("message:send", error);

        reply(callback, {
          success: false,
          message: "Unable to send message",
        });
      }
    }
  );

  // MESSAGE HISTORY
  socket.on(
    "message:history",
    async (payload, callback) => {
      try {
        const conversation =
          await findConversation(
            payload?.conversationId,
            currentUser.id
          );

        if (!conversation) {
          return reply(callback, {
            success: false,
            message: "Access denied",
          });
        }

        const limit = Math.min(
          50,
          Math.max(1, Number(payload?.limit) || 30)
        );

        const before =
          payload?.before &&
          validId(payload.before)
            ? {
                _id: {
                  $lt: new mongoose.Types.ObjectId(
                    payload.before
                  ),
                },
              }
            : {};

        const rows = await Message.find({
          conversation: conversation._id,
          ...before,
        })
          .sort({ _id: -1 })
          .limit(limit + 1)
          .lean();

        reply(callback, {
          success: true,
          data: rows
            .slice(0, limit)
            .reverse()
            .map(publicMessage),
          hasMore: rows.length > limit,
        });
      } catch (error) {
        console.error("message:history", error);

        reply(callback, {
          success: false,
          message: "Unable to load messages",
        });
      }
    }
  );

  // READ RECEIPTS
  socket.on(
    "message:read",
    async (payload, callback) => {
      try {
        const conversation =
          await findConversation(
            payload?.conversationId,
            currentUser.id
          );

        if (!conversation) {
          return reply(callback, {
            success: false,
            message: "Access denied",
          });
        }

        await Message.updateMany(
          {
            conversation: conversation._id,
            sender: { $ne: currentUser.id },
            readBy: {
              $ne: new mongoose.Types.ObjectId(
                currentUser.id
              ),
            },
          },
          {
            $addToSet: {
              readBy: new mongoose.Types.ObjectId(
                currentUser.id
              ),
            },
          }
        );

        for (const participantId of
          conversation.participants) {
          io.to(
            userRoom(asId(participantId))
          ).emit("message:read", {
            conversationId: asId(
              conversation._id
            ),
            userId: currentUser.id,
          });
        }

        reply(callback, {
          success: true,
        });

        await publishSummaries(io, conversation);
      } catch (error) {
        console.error("message:read", error);

        reply(callback, {
          success: false,
          message: "Unable to mark messages read",
        });
      }
    }
  );

  // TYPING INDICATORS
  for (const event of [
    "typing:start",
    "typing:stop",
  ]) {
    socket.on(event, async (conversationId) => {
      try {
        const conversation =
          await findConversation(
            conversationId,
            currentUser.id
          );

        if (!conversation) return;

        for (const participantId of
          conversation.participants) {
          const id = asId(participantId);

          if (id !== currentUser.id) {
            io.to(userRoom(id)).emit(event, {
              conversationId: asId(
                conversation._id
              ),
              userId: currentUser.id,
              name: currentUser.name,
            });
          }
        }
      } catch (error) {
        console.error(event, error);
      }
    });
  }

  // ONLINE STATUS
  socket.on(
    "presence:check",
    async (targetUserId, callback) => {
      try {
        if (!validId(targetUserId)) {
          return reply(callback, {
            success: false,
            message: "Invalid user",
          });
        }

        const shared = await Conversation.exists({
          participants: {
            $all: [
              currentUser.id,
              targetUserId,
            ],
          },
        });

        if (!shared) {
          return reply(callback, {
            success: false,
            message: "Access denied",
          });
        }

        reply(callback, {
          success: true,
          online: isOnline(io, targetUserId),
        });
      } catch (error) {
        console.error("presence:check", error);

        reply(callback, {
          success: false,
          message: "Unable to check presence",
        });
      }
    }
  );

  socket.on("disconnect", () => {
    console.log(
      `${currentUser.name} disconnected`
    );

    // The adapter updates room membership on disconnect.
    void broadcastPresence().catch(console.error);
  });
}