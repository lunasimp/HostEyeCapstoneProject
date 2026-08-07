import {
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

export class AccountStore {
  constructor(options) {
    this.file = options.file;
    this.bootstrapUsername = String(options.bootstrapUsername || "admin").trim();
    this.bootstrapPassword = String(options.bootstrapPassword || "hosteye-admin-demo");
    this.sessionTtlMs = Number(options.sessionTtlMinutes || 480) * 60 * 1000;
    this.sessions = new Map();
  }

  status() {
    const state = this.readState();
    return {
      initialized: state.users.length > 0,
      bootstrapUsername: this.bootstrapUsername,
      userCount: state.users.length,
    };
  }

  login(username, password) {
    const state = this.readState();
    const normalized = normalizeUsername(username);
    const user = state.users.find((item) => item.username.toLowerCase() === normalized.toLowerCase());
    if (!user || user.locked || !verifyPassword(String(password || ""), user.password)) {
      unauthorized("Invalid username or password");
    }
    const now = new Date();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    this.sessions.set(token, { userId: user.id, expiresAt: expiresAt.toISOString() });
    user.lastLoginAt = now.toISOString();
    user.updatedAt = now.toISOString();
    this.persist(state);
    return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user) };
  }

  logout(token) {
    if (token) this.sessions.delete(token);
  }

  authenticate(token) {
    if (!token) unauthorized("Authentication required");
    const session = this.sessions.get(token);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      if (session) this.sessions.delete(token);
      unauthorized("Session is missing or expired");
    }
    const state = this.readState();
    const user = state.users.find((item) => item.id === session.userId);
    if (!user || user.locked) {
      this.sessions.delete(token);
      unauthorized("Account is unavailable");
    }
    return publicUser(user);
  }

  list() {
    return this.readState().users.map(publicUser).sort((left, right) => left.username.localeCompare(right.username));
  }

  create(input, actor) {
    const state = this.readState();
    const username = normalizeUsername(input.username);
    if (state.users.some((item) => item.username.toLowerCase() === username.toLowerCase())) {
      conflict("Username already exists");
    }
    const password = normalizePassword(input.password);
    const now = new Date().toISOString();
    const user = {
      id: randomUUID(),
      username,
      displayName: normalizeDisplayName(input.displayName, username),
      role: normalizeRole(input.role),
      locked: Boolean(input.locked),
      password: hashPassword(password),
      createdAt: now,
      createdBy: actor.username,
      updatedAt: now,
      updatedBy: actor.username,
      lastLoginAt: null,
    };
    state.users.push(user);
    state.version += 1;
    this.persist(state);
    return publicUser(user);
  }

  update(id, input, actor) {
    const state = this.readState();
    const user = state.users.find((item) => item.id === id);
    if (!user) notFound("User account not found");
    if (input.username !== undefined) {
      const username = normalizeUsername(input.username);
      if (state.users.some((item) => item.id !== id && item.username.toLowerCase() === username.toLowerCase())) {
        conflict("Username already exists");
      }
      user.username = username;
    }
    if (input.displayName !== undefined) user.displayName = normalizeDisplayName(input.displayName, user.username);
    if (input.role !== undefined) {
      const role = normalizeRole(input.role);
      this.ensureAdminRemains(state, user, { role, locked: user.locked });
      user.role = role;
    }
    if (input.password !== undefined && String(input.password).length > 0) {
      user.password = hashPassword(normalizePassword(input.password));
      this.revokeUserSessions(user.id);
    }
    user.updatedAt = new Date().toISOString();
    user.updatedBy = actor.username;
    state.version += 1;
    this.persist(state);
    return publicUser(user);
  }

  setLocked(id, locked, actor) {
    const state = this.readState();
    const user = state.users.find((item) => item.id === id);
    if (!user) notFound("User account not found");
    this.ensureAdminRemains(state, user, { role: user.role, locked });
    user.locked = locked;
    user.updatedAt = new Date().toISOString();
    user.updatedBy = actor.username;
    state.version += 1;
    if (locked) this.revokeUserSessions(user.id);
    this.persist(state);
    return publicUser(user);
  }

  readState() {
    if (!existsSync(this.file)) {
      const now = new Date().toISOString();
      const state = {
        version: 1,
        users: [{
          id: randomUUID(),
          username: normalizeUsername(this.bootstrapUsername),
          displayName: "HostEye Administrator",
          role: "admin",
          locked: false,
          password: hashPassword(normalizePassword(this.bootstrapPassword)),
          createdAt: now,
          createdBy: "system-bootstrap",
          updatedAt: now,
          updatedBy: "system-bootstrap",
          lastLoginAt: null,
        }],
      };
      this.persist(state);
      return state;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      const failure = new Error("Stored Dashboard user accounts are not valid JSON");
      failure.detail = error.message;
      throw failure;
    }
    if (!parsed || !Array.isArray(parsed.users)) throw new Error("Stored Dashboard user accounts are invalid");
    return { version: Number(parsed.version || 1), users: parsed.users };
  }

  persist(state) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, this.file);
  }

  ensureAdminRemains(state, target, next) {
    if (target.role !== "admin" || target.locked) return;
    if (next.role === "admin" && !next.locked) return;
    const otherActiveAdmins = state.users.filter((item) => item.id !== target.id && item.role === "admin" && !item.locked);
    if (!otherActiveAdmins.length) conflict("At least one active administrator account is required");
  }

  revokeUserSessions(userId) {
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) this.sessions.delete(token);
    }
  }
}

export function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    locked: Boolean(user.locked),
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    updatedAt: user.updatedAt,
    updatedBy: user.updatedBy,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!USERNAME_PATTERN.test(username)) badRequest("username must be 3-64 characters using letters, numbers, dot, underscore, or hyphen");
  return username;
}

function normalizeDisplayName(value, fallback) {
  const displayName = String(value || fallback || "").trim();
  if (!displayName || displayName.length > 100) badRequest("displayName must be between 1 and 100 characters");
  return displayName;
}

function normalizeRole(value) {
  const role = String(value || "user").trim().toLowerCase();
  if (!['admin', 'user'].includes(role)) badRequest("role must be one of: admin, user");
  return role;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 200) badRequest("password must be between 10 and 200 characters");
  return password;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  return {
    algorithm: "pbkdf2-sha256",
    iterations: PASSWORD_ITERATIONS,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}

function verifyPassword(password, stored) {
  if (!stored || stored.algorithm !== "pbkdf2-sha256") return false;
  const salt = Buffer.from(stored.salt, "base64");
  const expected = Buffer.from(stored.hash, "base64");
  const actual = pbkdf2Sync(password, salt, Number(stored.iterations), expected.length, PASSWORD_DIGEST);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function badRequest(message) { httpError(400, message); }
function unauthorized(message) { httpError(401, message); }
function notFound(message) { httpError(404, message); }
function conflict(message) { httpError(409, message); }
