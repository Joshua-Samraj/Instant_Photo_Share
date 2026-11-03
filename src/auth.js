const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');

const PHOTOGRAPHER_ROLE = 'photographer';
const GUEST_ROLE = 'guest';

function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

function signPhotographerToken(photographer) {
    return jwt.sign(
        {
            role: PHOTOGRAPHER_ROLE,
            sub: String(photographer._id),
            email: photographer.email,
            name: photographer.name,
            studioName: photographer.studioName
        },
        config.jwtSecret,
        { expiresIn: `${config.sessionDays}d` }
    );
}

function signGuestToken(customer) {
    return jwt.sign(
        {
            role: GUEST_ROLE,
            sub: String(customer._id),
            eventId: String(customer.eventId),
            name: customer.name
        },
        config.jwtSecret,
        { expiresIn: `${config.guestSessionHours}h` }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, config.jwtSecret);
    } catch (error) {
        return null;
    }
}

function readBearerToken(req) {
    const header = req.get('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) {
        return header.slice(7).trim();
    }
    return null;
}

function readToken(req) {
    if (req.cookies && req.cookies[config.sessionCookie]) {
        return req.cookies[config.sessionCookie];
    }
    return readBearerToken(req);
}

function cookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        path: '/',
        maxAge: config.sessionDays * 24 * 60 * 60 * 1000
    };
}

function setSessionCookie(res, token) {
    res.cookie(config.sessionCookie, token, cookieOptions());
}

function clearSessionCookie(res) {
    res.clearCookie(config.sessionCookie, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        path: '/'
    });
}

function requirePhotographer(req, res, next) {
    const payload = verifyToken(readToken(req));
    if (!payload || payload.role !== PHOTOGRAPHER_ROLE || !payload.sub) {
        return res.status(401).json({ error: 'Sign in to continue.', code: 'UNAUTHENTICATED' });
    }
    req.photographer = {
        id: String(payload.sub),
        email: payload.email,
        name: payload.name,
        studioName: payload.studioName
    };
    return next();
}

function requireGuest(req, res, next) {
    // Prefer the explicit guest credential over the shared session cookie.
    // A photographer testing their own guest link in the same browser still
    // has the photographer cookie set, which must not shadow the guest token.
    const token =
        (req.body && req.body.guestToken) ||
        readBearerToken(req) ||
        (req.cookies && req.cookies[config.sessionCookie]);
    const payload = verifyToken(token);
    if (!payload || payload.role !== GUEST_ROLE || !payload.sub || !payload.eventId) {
        return res.status(401).json({
            error: 'Your gallery session has expired. Please register again.',
            code: 'GUEST_SESSION_EXPIRED'
        });
    }
    req.guest = {
        id: String(payload.sub),
        eventId: String(payload.eventId),
        name: payload.name
    };
    return next();
}

/**
 * Best-effort, per-instance rate limiter. Serverless instances do not share
 * memory, but this still blunts credential stuffing and registration spam.
 */
function createRateLimiter({ windowMs, max, message }) {
    const hits = new Map();

    return function rateLimiter(req, res, next) {
        const now = Date.now();
        const key = `${req.ip || 'unknown'}:${req.path}`;
        const entry = hits.get(key);

        if (!entry || entry.resetAt <= now) {
            hits.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }

        entry.count += 1;
        if (entry.count > max) {
            const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: message || 'Too many attempts. Try again shortly.' });
        }
        return next();
    };
}

function publicPhotographer(photographer) {
    return {
        id: String(photographer._id),
        name: photographer.name,
        studioName: photographer.studioName,
        email: photographer.email,
        createdAt: photographer.createdAt
    };
}

module.exports = {
    PHOTOGRAPHER_ROLE,
    GUEST_ROLE,
    hashPassword,
    verifyPassword,
    signPhotographerToken,
    signGuestToken,
    verifyToken,
    readToken,
    setSessionCookie,
    clearSessionCookie,
    requirePhotographer,
    requireGuest,
    createRateLimiter,
    publicPhotographer
};
