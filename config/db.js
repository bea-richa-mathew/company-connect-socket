
import mongoose from "mongoose";
import dns from "node:dns";

// Use the same DNS configuration as the existing backend.
dns.setServers([
  "8.8.8.8",
  "8.8.4.4",
]);

export async function connectDB() {
  try {
    const mongoURI = process.env.MONGO_URI;

    if (!mongoURI) {
      throw new Error(
        "MONGO_URI is missing from socket/.env"
      );
    }

    console.log("Connecting to MongoDB Atlas...");

    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 15000,
    });

    console.log(
      "Socket server connected to MongoDB Atlas"
    );

    console.log(
      "Connected database:",
      mongoose.connection.name
    );
  } catch (error) {
    console.error(
      "MongoDB connection failed:",
      error.message
    );

    throw error;
  }
}
