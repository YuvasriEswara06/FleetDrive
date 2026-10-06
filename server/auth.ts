import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import type { User } from "@shared/schema";

export const JWT_SECRET = process.env.JWT_SECRET || "fleetdrive-cn-secure-hmac-sha256-key-2026";
export const TOKEN_EXPIRY = "4h";

export interface AuthenticatedUserPayload {
  id: string;
  username: string;
  role: "driver" | "dispatcher";
  name: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUserPayload;
}

/**
 * Generates an HMAC-SHA256 signed JSON Web Token (RFC 7519)
 */
export function generateToken(user: Pick<User, "id" | "username" | "role" | "name">): string {
  const payload: AuthenticatedUserPayload = {
    id: user.id,
    username: user.username,
    role: user.role as "driver" | "dispatcher",
    name: user.name,
  };

  return jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: TOKEN_EXPIRY,
  });
}

/**
 * Cryptographically verifies a JWT token string
 */
export function verifyToken(token: string): AuthenticatedUserPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    return decoded as AuthenticatedUserPayload;
  } catch (err) {
    return null;
  }
}

/**
 * Express Middleware: Enforces Authorization: Bearer <token>
 * Returns 401 Unauthorized if missing, 403 Forbidden if signature invalid.
 */
export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers["authorization"] || req.header("authorization");

  if (!authHeader) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Access Denied: Missing 'Authorization: Bearer <token>' header",
    });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({
      error: "MALFORMED_AUTH_HEADER",
      message: "Authorization format must be 'Bearer <token>'",
    });
  }

  const token = parts[1];
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Cryptographic signature verification failed or token has expired",
    });
  }

  req.user = decoded;
  next();
}

/**
 * Hash password with a unique cryptographic random salt (PBKDF2-SHA512)
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify plaintext password against stored salted hash
 * Supports backward-compatibility for legacy plain seed data during migration
 */
export function verifyPassword(password: string, storedHashOrPlain: string): boolean {
  if (!storedHashOrPlain.includes(":")) {
    // Legacy plain string comparison
    return password === storedHashOrPlain;
  }

  const [salt, originalHash] = storedHashOrPlain.split(":");
  const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return originalHash === testHash;
}
