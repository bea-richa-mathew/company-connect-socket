
import mongoose from "mongoose";
import Conversation from "../models/Conversation.js";

const { Types } = mongoose;

const validId = mongoose.isValidObjectId;
const idOf = (value) => String(value);
const objectId = (value) => new Types.ObjectId(value);

const userRoom = (id) => `user:${idOf(id)}`;
const chatRoom = (id) => `conversation:${idOf(id)}`;

const MAX_MESSAGES = 10000;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_GROUP_MEMBERS = 50;
const MAX_DOCUMENT_BYTES = 14 * 1024 * 1024;

// --------------------------------------------
// GENERAL HELPERS
// --------------------------------------------

function respond(callback, result) {
  if (typeof callback === "function") {
    callback(result);
  }
}

function errorResult(message) {
  return {
    success: false,
    message,
  };
}

function isOnline(io, userId) {
  return Boolean(
    io.sockets.adapter.rooms.get(
      userRoom(userId)
    )?.size
  );
}

function publicUser(user, io) {
  return {
    _id: idOf(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    employeeId: user.employeeId,
    profileImage: user.profileImage,
    online: isOnline(io, user._id),
  };
}

function publicMessage(message, conversationId) {
  return {
    _id: idOf(message._id),
    conversationId: idOf(conversationId),
    sender: idOf(message.sender),
    text: message.text,
    readBy: (message.readBy || []).map(idOf),
    createdAt: message.createdAt,
  };
}

function isAdmin(conversation, userId) {
  return (
    conversation.type === "group" &&
    (
      (conversation.admins || []).some(
        (id) => idOf(id) === idOf(userId)
      ) ||
      (
        conversation.createdBy &&
        idOf(conversation.createdBy) === idOf(userId)
      )
    )
  );
}

// --------------------------------------------
// DATABASE HELPERS
// --------------------------------------------

async function getConversation(
  conversationId,
  userId
) {
  if (!validId(conversationId)) {
    return null;
  }

  return Conversation.findOne({
    _id: conversationId,
    participants: userId,
  });
}

async function getUsers(ids) {
  const validIds = ids.filter(validId);

  if (!validIds.length) {
    return [];
  }

  return mongoose.connection
    .collection("users")
    .find({
      _id: {
        $in: validIds.map(objectId),
      },
    })
    .project({
      name: 1,
      email: 1,
      role: 1,
      department: 1,
      employeeId: 1,
      profileImage: 1,
      isActive: 1,
    })
    .toArray();
}

async function resolveMembers(values, me) {
  if (!Array.isArray(values)) {
    throw new Error("Members must be an array");
  }

  const inputs = [
    ...new Set(
      values
        .filter(
          (value) => typeof value === "string"
        )
        .map((value) =>
          value.trim().toLowerCase()
        )
        .filter(Boolean)
    ),
  ];

  if (inputs.length > 49) {
    throw new Error("Maximum group size is 50");
  }

  if (!inputs.length) {
    return [];
  }

  const ids = inputs.filter(validId);
  const emails = inputs.filter(
    (value) => !validId(value)
  );

  const conditions = [];

  if (ids.length) {
    conditions.push({
      _id: {
        $in: ids.map(objectId),
      },
    });
  }

  if (emails.length) {
    conditions.push({
      email: {
        $in: emails,
      },
    });
  }

  const users = await mongoose.connection
    .collection("users")
    .find({
      $or: conditions,
      role: {
        $in: ["employee", "admin"],
      },
      isActive: true,
    })
    .toArray();

  if (users.length !== inputs.length) {
    throw new Error(
      "Some email addresses or users were not found"
    );
  }

  return [
    ...new Set(
      users
        .map((user) => idOf(user._id))
        .filter((id) => id !== idOf(me))
    ),
  ];
}

// --------------------------------------------
// CONVERSATION LIST
// --------------------------------------------

async function listConversations(userId, io) {
  const conversations = await Conversation.find({
    participants: userId,
  })
    .select("-messages")
    .sort({
      lastMessageAt: -1,
      updatedAt: -1,
    })
    .limit(200)
    .lean();

  const results = [];

  for (const summary of conversations) {
    const conversation =
      await Conversation.findById(summary._id)
        .select("messages")
        .lean();

    const messages =
      conversation?.messages || [];

    const lastMessage =
      messages.length > 0
        ? messages[messages.length - 1]
        : null;

    const unreadCount = messages.filter(
      (message) =>
        idOf(message.sender) !== idOf(userId) &&
        !(message.readBy || []).some(
          (id) => idOf(id) === idOf(userId)
        )
    ).length;

    const otherIds = summary.participants
      .map(idOf)
      .filter((id) => id !== idOf(userId));

    const users = await getUsers(otherIds);

    results.push({
      _id: idOf(summary._id),
      type: summary.type || "direct",
      name: summary.name || "",
      description: summary.description || "",
      groupImage: summary.groupImage || "",
      createdBy: summary.createdBy
        ? idOf(summary.createdBy)
        : null,
      admins: (summary.admins || []).map(idOf),
      participantIds:
        summary.participants.map(idOf),
      participants: users.map((user) =>
        publicUser(user, io)
      ),
      lastMessage: lastMessage
        ? publicMessage(
            lastMessage,
            summary._id
          )
        : null,
      lastMessageAt: summary.lastMessageAt,
      unreadCount,
      online: users.some((user) =>
        isOnline(io, user._id)
      ),
    });
  }

  return results;
}

async function notifyConversation(
  io,
  conversation
) {
  for (const participantId of conversation.participants) {
    const userId = idOf(participantId);

    io.to(userRoom(userId)).emit(
      "conversations:changed",
      await listConversations(userId, io)
    );
  }
}

// --------------------------------------------
// EMBEDDED MESSAGE STORAGE
// --------------------------------------------

async function saveEmbeddedMessage(
  conversationId,
  senderId,
  text
) {
  const message = {
    _id: new Types.ObjectId(),
    sender: objectId(senderId),
    text,
    readBy: [objectId(senderId)],
    createdAt: new Date(),
  };

  const estimatedMessageBytes =
    Buffer.byteLength(text, "utf8") + 1024;

  // Atomic update:
  // Append to the existing conversation document.
  // No Message.create() and no separate messages
  // collection are used.

  const updated =
    await Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        participants: objectId(senderId),

        "messages.9999": {
          $exists: false,
        },

        $expr: {
          $lt: [
            {
              $add: [
                {
                  $bsonSize: "$$ROOT",
                },
                estimatedMessageBytes,
              ],
            },
            MAX_DOCUMENT_BYTES,
          ],
        },
      },
      {
        $push: {
          messages: message,
        },
        $inc: {
          messageCount: 1,
        },
        $set: {
          lastMessageAt: message.createdAt,
        },
      },
      {
        new: false,
        projection: {
          _id: 1,
        },
      }
    );

  if (!updated) {
    throw new Error(
      "Conversation unavailable or storage limit reached"
    );
  }

  return message;
}

// --------------------------------------------
// SOCKET HANDLERS
// --------------------------------------------

export function registerChatHandlers(io, socket) {
  const currentUser = socket.data.user;
  const me = idOf(currentUser.id);

  socket.join(userRoom(me));

  // ------------------------------------------
  // PRESENCE BROADCAST
  // ------------------------------------------

  async function broadcastPresence(online) {
    const conversations =
      await Conversation.find({
        participants: me,
      })
        .select("participants")
        .lean();

    const otherUsers = new Set();

    for (const conversation of conversations) {
      for (const participant of conversation.participants) {
        const id = idOf(participant);

        if (id !== me) {
          otherUsers.add(id);
        }
      }
    }

    for (const userId of otherUsers) {
      io.to(userRoom(userId)).emit(
        "presence:changed",
        {
          userId: me,
          online,
        }
      );
    }
  }

  void broadcastPresence(true).catch(
    console.error
  );

  // ------------------------------------------
  // LIST CONTACTS
  // ------------------------------------------

  socket.on("contacts:list", async (callback) => {
    try {
      const users = await mongoose.connection
        .collection("users")
        .find({
          _id: {
            $ne: objectId(me),
          },
          role: {
            $in: ["employee", "admin"],
          },
          isActive: true,
        })
        .sort({ name: 1 })
        .limit(200)
        .toArray();

      respond(callback, {
        success: true,
        data: users.map((user) =>
          publicUser(user, io)
        ),
      });
    } catch (error) {
      console.error(
        "contacts:list:",
        error
      );

      respond(
        callback,
        errorResult(
          "Unable to load contacts"
        )
      );
    }
  });

  // ------------------------------------------
  // SEARCH CONTACTS
  // ------------------------------------------

  socket.on(
    "contacts:search",
    async (payload, callback) => {
      try {
        const query = String(
          payload?.query || ""
        ).trim();

        if (
          query.length < 2 ||
          query.length > 100
        ) {
          return respond(callback, {
            success: true,
            data: [],
          });
        }

        const escaped = query.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

        const users =
          await mongoose.connection
            .collection("users")
            .find({
              _id: {
                $ne: objectId(me),
              },
              role: {
                $in: ["employee", "admin"],
              },
              isActive: true,
              $or: [
                {
                  name: {
                    $regex: escaped,
                    $options: "i",
                  },
                },
                {
                  email: {
                    $regex: escaped,
                    $options: "i",
                  },
                },
              ],
            })
            .limit(30)
            .toArray();

        respond(callback, {
          success: true,
          data: users.map((user) =>
            publicUser(user, io)
          ),
        });
      } catch (error) {
        console.error(
          "contacts:search:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to search contacts"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // LIST CONVERSATIONS
  // ------------------------------------------

  socket.on(
    "conversations:list",
    async (callback) => {
      try {
        const data =
          await listConversations(me, io);

        respond(callback, {
          success: true,
          data,
        });
      } catch (error) {
        console.error(
          "conversations:list:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to load conversations"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // CREATE OR REOPEN DIRECT CHAT
  // ------------------------------------------

  socket.on(
    "conversation:create",
    async (payload, callback) => {
      try {
        const target = String(
          payload?.userId || ""
        );

        if (
          !validId(target) ||
          target === me
        ) {
          return respond(
            callback,
            errorResult("Invalid contact")
          );
        }

        const users =
          await getUsers([target]);

        if (
          users.length !== 1 ||
          users[0].isActive !== true ||
          !["employee", "admin"].includes(
            users[0].role
          )
        ) {
          return respond(
            callback,
            errorResult(
              "Contact unavailable"
            )
          );
        }

        const participants = [
          me,
          target,
        ].sort();

        const directKey =
          participants.join(":");

        // Reuse an existing conversation.
        // Never create a new conversation for
        // every message.

        let conversation =
          await Conversation.findOne({
            type: "direct",
            directKey,
          });

        // Compatibility with older direct chats
        // that may not have a directKey.
        if (!conversation) {
          conversation =
            await Conversation.findOne({
              type: "direct",
              participants: {
                $all: participants,
                $size: 2,
              },
            }).sort({
              createdAt: 1,
            });

          if (
            conversation &&
            !conversation.directKey
          ) {
            try {
              await Conversation.updateOne(
                {
                  _id: conversation._id,
                  $or: [
                    { directKey: { $exists: false } },
                    { directKey: null },
                    { directKey: "" },
                  ],
                },
                {
                  $set: {
                    directKey,
                  },
                }
              );
            } catch (error) {
              if (error.code !== 11000) {
                throw error;
              }

              conversation =
                await Conversation.findOne({
                  type: "direct",
                  directKey,
                });
            }
          }
        }

        if (!conversation) {
          conversation =
            await Conversation.findOneAndUpdate(
              {
                directKey,
              },
              {
                $setOnInsert: {
                  type: "direct",
                  directKey,
                  participants,
                  messages: [],
                  messageCount: 0,
                },
              },
              {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
              }
            );
        }

        socket.join(
          chatRoom(conversation._id)
        );

        respond(callback, {
          success: true,
          data: {
            conversationId: idOf(
              conversation._id
            ),
          },
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "conversation:create:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to create conversation"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // CREATE GROUP
  // ------------------------------------------

  socket.on(
    "group:create",
    async (payload, callback) => {
      try {
        const name = String(
          payload?.name || ""
        ).trim();

        const description = String(
          payload?.description || ""
        ).trim();

        if (
          !name ||
          name.length > 100
        ) {
          return respond(
            callback,
            errorResult(
              "Group name must be 1–100 characters"
            )
          );
        }

        if (
          description.length > 500
        ) {
          return respond(
            callback,
            errorResult(
              "Description must be at most 500 characters"
            )
          );
        }

        const memberIds =
          await resolveMembers(
            payload?.memberIds || [],
            me
          );

        if (
          memberIds.length < 1
        ) {
          return respond(
            callback,
            errorResult(
              "Select at least one other member"
            )
          );
        }

        const conversation =
          await Conversation.create({
            type: "group",
            name,
            description,
            participants: [
              me,
              ...memberIds,
            ],
            createdBy: me,
            admins: [me],
            messages: [],
            messageCount: 0,
          });

        socket.join(
          chatRoom(conversation._id)
        );

        respond(callback, {
          success: true,
          data: {
            conversationId: idOf(
              conversation._id
            ),
          },
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "group:create:",
          error
        );

        respond(
          callback,
          errorResult(
            error.message ||
              "Unable to create group"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // UPDATE GROUP
  // ------------------------------------------

  socket.on(
    "group:update",
    async (payload, callback) => {
      try {
        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (
          !conversation ||
          !isAdmin(conversation, me)
        ) {
          return respond(
            callback,
            errorResult(
              "Group admin access required"
            )
          );
        }

        if (
          typeof payload?.name === "string"
        ) {
          const name =
            payload.name.trim();

          if (
            !name ||
            name.length > 100
          ) {
            return respond(
              callback,
              errorResult(
                "Invalid group name"
              )
            );
          }

          conversation.name = name;
        }

        if (
          typeof payload?.description ===
          "string"
        ) {
          if (
            payload.description.length > 500
          ) {
            return respond(
              callback,
              errorResult(
                "Description too long"
              )
            );
          }

          conversation.description =
            payload.description.trim();
        }

        await conversation.save();

        respond(callback, {
          success: true,
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "group:update:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to update group"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // ADD GROUP MEMBERS
  // ------------------------------------------

  socket.on(
    "group:add-members",
    async (payload, callback) => {
      try {
        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (
          !conversation ||
          !isAdmin(conversation, me)
        ) {
          return respond(
            callback,
            errorResult(
              "Group admin access required"
            )
          );
        }

        const newIds =
          await resolveMembers(
            payload?.memberIds || [],
            me
          );

        const existing = new Set(
          conversation.participants.map(idOf)
        );

        const additions =
          newIds.filter(
            (id) => !existing.has(id)
          );

        if (!additions.length) {
          return respond(
            callback,
            errorResult(
              "No new members selected"
            )
          );
        }

        if (
          existing.size +
            additions.length >
          MAX_GROUP_MEMBERS
        ) {
          return respond(
            callback,
            errorResult(
              "Maximum group size is 50"
            )
          );
        }

        conversation.participants.push(
          ...additions
        );

        await conversation.save();

        respond(callback, {
          success: true,
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "group:add-members:",
          error
        );

        respond(
          callback,
          errorResult(
            error.message ||
              "Unable to add group members"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // REMOVE GROUP MEMBER
  // ------------------------------------------

  socket.on(
    "group:remove-member",
    async (payload, callback) => {
      try {
        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (
          !conversation ||
          !isAdmin(conversation, me)
        ) {
          return respond(
            callback,
            errorResult(
              "Group admin access required"
            )
          );
        }

        const targetId = String(
          payload?.userId || ""
        );

        if (
          !validId(targetId) ||
          !conversation.participants.some(
            (id) =>
              idOf(id) === targetId
          )
        ) {
          return respond(
            callback,
            errorResult(
              "Member not found"
            )
          );
        }

        if (
          idOf(
            conversation.createdBy
          ) === targetId
        ) {
          return respond(
            callback,
            errorResult(
              "The group creator cannot be removed"
            )
          );
        }

        if (
          conversation.participants.length <= 2
        ) {
          return respond(
            callback,
            errorResult(
              "A group must retain two members"
            )
          );
        }

        conversation.participants =
          conversation.participants.filter(
            (id) =>
              idOf(id) !== targetId
          );

        conversation.admins =
          conversation.admins.filter(
            (id) =>
              idOf(id) !== targetId
          );

        await conversation.save();

        const removedSockets =
          await io
            .in(userRoom(targetId))
            .fetchSockets();

        for (
          const client of removedSockets
        ) {
          client.leave(
            chatRoom(
              conversation._id
            )
          );
        }

        io.to(
          userRoom(targetId)
        ).emit(
          "conversation:removed",
          {
            conversationId: idOf(
              conversation._id
            ),
          }
        );

        respond(callback, {
          success: true,
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "group:remove-member:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to remove member"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // LEAVE GROUP
  // ------------------------------------------

  socket.on(
    "group:leave",
    async (payload, callback) => {
      try {
        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (
          !conversation ||
          conversation.type !== "group"
        ) {
          return respond(
            callback,
            errorResult(
              "Group unavailable"
            )
          );
        }

        if (
          conversation.participants.length <= 2
        ) {
          return respond(
            callback,
            errorResult(
              "Cannot leave a group with only two members"
            )
          );
        }

        const remaining =
          conversation.participants.filter(
            (id) =>
              idOf(id) !== me
          );

        conversation.participants =
          remaining;

        conversation.admins =
          conversation.admins.filter(
            (id) =>
              idOf(id) !== me
          );

        if (
          idOf(
            conversation.createdBy
          ) === me
        ) {
          conversation.createdBy =
            remaining[0];
        }

        if (
          !conversation.admins.length
        ) {
          conversation.admins = [
            remaining[0],
          ];
        }

        await conversation.save();

        socket.leave(
          chatRoom(
            conversation._id
          )
        );

        io.to(
          userRoom(me)
        ).emit(
          "conversation:removed",
          {
            conversationId: idOf(
              conversation._id
            ),
          }
        );

        respond(callback, {
          success: true,
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "group:leave:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to leave group"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // JOIN CONVERSATION
  // ------------------------------------------

  socket.on(
    "conversation:join",
    async (
      conversationId,
      callback
    ) => {
      try {
        const conversation =
          await getConversation(
            conversationId,
            me
          );

        if (!conversation) {
          return respond(
            callback,
            errorResult(
              "Access denied"
            )
          );
        }

        socket.join(
          chatRoom(
            conversationId
          )
        );

        respond(callback, {
          success: true,
        });
      } catch (error) {
        console.error(
          "conversation:join:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to join conversation"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // LEAVE CONVERSATION ROOM
  // ------------------------------------------

  socket.on(
    "conversation:leave",
    (conversationId) => {
      if (
        validId(
          conversationId
        )
      ) {
        socket.leave(
          chatRoom(
            conversationId
          )
        );
      }
    }
  );

  // ------------------------------------------
  // SEND MESSAGE
  // ONE CHAT = ONE MONGODB DOCUMENT
  // ------------------------------------------

  socket.on(
    "message:send",
    async (payload, callback) => {
      try {
        const text =
          typeof payload?.text === "string"
            ? payload.text.trim()
            : "";

        if (
          !text ||
          text.length > MAX_MESSAGE_LENGTH
        ) {
          return respond(
            callback,
            errorResult(
              "Message must contain 1–5000 characters"
            )
          );
        }

        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (!conversation) {
          return respond(
            callback,
            errorResult(
              "Access denied"
            )
          );
        }

        // This adds the message to the
        // existing conversation document.
        const message =
          await saveEmbeddedMessage(
            conversation._id,
            me,
            text
          );

        const data =
          publicMessage(
            message,
            conversation._id
          );

        for (
          const participantId of
          conversation.participants
        ) {
          io.to(
            userRoom(
              participantId
            )
          ).emit(
            "message:new",
            data
          );
        }

        respond(callback, {
          success: true,
          data,
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "message:send:",
          error
        );

        respond(
          callback,
          errorResult(
            error.message ||
              "Unable to send message"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // MESSAGE HISTORY
  // READ FROM THE SAME DOCUMENT
  // ------------------------------------------

  socket.on(
    "message:history",
    async (payload, callback) => {
      try {
        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (!conversation) {
          return respond(
            callback,
            errorResult(
              "Access denied"
            )
          );
        }

        const limit = Math.min(
          50,
          Math.max(
            1,
            Number(
              payload?.limit
            ) || 30
          )
        );

        let messages =
          conversation.messages || [];

        if (
          payload?.before &&
          validId(
            payload.before
          )
        ) {
          const beforeId =
            idOf(
              payload.before
            );

          messages =
            messages.filter(
              (message) =>
                idOf(
                  message._id
                ) < beforeId
            );
        }

        const hasMore =
          messages.length > limit;

        const selected =
          messages.slice(
            -limit
          );

        respond(callback, {
          success: true,
          data: selected.map(
            (message) =>
              publicMessage(
                message,
                conversation._id
              )
          ),
          hasMore,
        });
      } catch (error) {
        console.error(
          "message:history:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to load messages"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // MARK MESSAGES AS READ
  // ------------------------------------------

  socket.on(
    "message:read",
    async (payload, callback) => {
      try {
        const conversation =
          await getConversation(
            payload?.conversationId,
            me
          );

        if (!conversation) {
          return respond(
            callback,
            errorResult(
              "Access denied"
            )
          );
        }

        await Conversation.updateOne(
          {
            _id:
              conversation._id,
            participants:
              objectId(me),
          },
          {
            $addToSet: {
              "messages.$[message].readBy":
                objectId(me),
            },
          },
          {
            arrayFilters: [
              {
                "message.sender": {
                  $ne:
                    objectId(me),
                },
                "message.readBy": {
                  $ne:
                    objectId(me),
                },
              },
            ],
          }
        );

        for (
          const participantId of
          conversation.participants
        ) {
          io.to(
            userRoom(
              participantId
            )
          ).emit(
            "message:read",
            {
              conversationId:
                idOf(
                  conversation._id
                ),
              userId: me,
            }
          );
        }

        respond(callback, {
          success: true,
        });

        await notifyConversation(
          io,
          conversation
        );
      } catch (error) {
        console.error(
          "message:read:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to mark messages read"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // TYPING INDICATORS
  // ------------------------------------------

  for (
    const event of [
      "typing:start",
      "typing:stop",
    ]
  ) {
    socket.on(
      event,
      async (
        conversationId
      ) => {
        try {
          const conversation =
            await getConversation(
              conversationId,
              me
            );

          if (
            !conversation
          ) {
            return;
          }

          for (
            const participantId of
            conversation.participants
          ) {
            if (
              idOf(
                participantId
              ) === me
            ) {
              continue;
            }

            io.to(
              userRoom(
                participantId
              )
            ).emit(
              event,
              {
                conversationId:
                  idOf(
                    conversation._id
                  ),
                userId: me,
                name:
                  currentUser.name,
              }
            );
          }
        } catch (error) {
          console.error(
            event,
            error
          );
        }
      }
    );
  }

  // ------------------------------------------
  // CHECK ONLINE STATUS
  // ------------------------------------------

  socket.on(
    "presence:check",
    async (
      targetUserId,
      callback
    ) => {
      try {
        if (
          !validId(
            targetUserId
          )
        ) {
          return respond(
            callback,
            errorResult(
              "Invalid user"
            )
          );
        }

        const shared =
          await Conversation.exists({
            participants: {
              $all: [
                me,
                targetUserId,
              ],
            },
          });

        if (!shared) {
          return respond(
            callback,
            errorResult(
              "Access denied"
            )
          );
        }

        respond(callback, {
          success: true,
          online:
            isOnline(
              io,
              targetUserId
            ),
        });
      } catch (error) {
        console.error(
          "presence:check:",
          error
        );

        respond(
          callback,
          errorResult(
            "Unable to check presence"
          )
        );
      }
    }
  );

  // ------------------------------------------
  // DISCONNECT
  // ------------------------------------------

  socket.on(
    "disconnect",
    async () => {
      try {
        const remaining =
          await io
            .in(
              userRoom(me)
            )
            .fetchSockets();

        if (
          remaining.length === 0
        ) {
          await broadcastPresence(
            false
          );
        }
      } catch (error) {
        console.error(
          "presence disconnect:",
          error
        );
      }
    }
  );
}
