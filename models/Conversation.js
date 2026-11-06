import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],

    type: {
      type: String,
      enum: ["direct", "group"],
      default: "direct",
    },

    directKey: {
      type: String,
      unique: true,
      sparse: true,
    },

    name: {
      type: String,
      default: "",
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

conversationSchema.index({
  participants: 1,
  lastMessageAt: -1,
});

export default mongoose.model(
  "Conversation",
  conversationSchema
);