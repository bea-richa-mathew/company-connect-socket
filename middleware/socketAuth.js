import jwt from "jsonwebtoken";
import mongoose from "mongoose";

function getCookie(header, name) {
  const cookies = String(header || "").split(";");

  const entry = cookies
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  if (!entry) return null;

  try {
    return decodeURIComponent(
      entry.slice(name.length + 1)
    );
  } catch {
    return null;
  }
}

export async function socketAuth(socket, next) {
  try {
    const suppliedToken =
      socket.handshake.auth?.token;

    const bearerToken =
      typeof suppliedToken === "string"
        ? suppliedToken
        : null;

    const adminCookie = getCookie(
      socket.handshake.headers.cookie,
      "company_portal_admin_session"
    );

    const token = bearerToken || adminCookie;

    if (!token || !process.env.JWT_SECRET) {
      return next(
        new Error("Authentication required")
      );
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET,
      { algorithms: ["HS256"] }
    );

    if (
      !decoded ||
      typeof decoded !== "object" ||
      !mongoose.isValidObjectId(decoded.id)
    ) {
      return next(new Error("Invalid token"));
    }

    const user = await mongoose.connection
      .collection("users")
      .findOne(
        {
          _id: new mongoose.Types.ObjectId(
            decoded.id
          ),
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
          },
        }
      );

    if (!user) {
      return next(
        new Error("Account unavailable")
      );
    }

    socket.data.user = {
      id: String(user._id),
      name: user.name,
      role: user.role,
    };

    next();
  } catch {
    next(new Error("Authentication failed"));
  }
}