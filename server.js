"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Pool } = require("pg");

loadEnvFile();

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const secret = process.env.AUTH_SECRET || "";
const sessionCookie = "techstore_session";
const sessionDuration = 7 * 24 * 60 * 60;
const databaseUrl = process.env.DATABASE_URL;
const pool = new Pool({
    ...(databaseUrl ? { connectionString: databaseUrl } : {
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || "postgres",
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || ""
    }),
    ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
    max: Number(process.env.PGPOOL_MAX || 5),
    connectionTimeoutMillis: 10000
});

function loadEnvFile() {
    const file = path.join(__dirname, ".env");
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !Object.hasOwn(process.env, match[1])) {
            process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
        }
    }
}

function sendJson(response, status, data, headers = {}) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers
    });
    response.end(JSON.stringify(data));
}

function parseCookies(header = "") {
    return Object.fromEntries(header.split(";").map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return ["", ""];
        return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }));
}

function createSession(customerId) {
    const payload = Buffer.from(`${customerId}.${Date.now() + sessionDuration * 1000}`).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function readSession(request) {
    if (!secret) return null;
    const token = parseCookies(request.headers.cookie)[sessionCookie];
    if (!token) return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    let received;
    try {
        received = Buffer.from(signature, "base64url");
    } catch {
        return null;
    }
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
    try {
        const [customerId, expiresAt] = Buffer.from(payload, "base64url").toString("utf8").split(".");
        if (!/^\d+$/.test(customerId) || Number(expiresAt) <= Date.now()) return null;
        return Number(customerId);
    } catch {
        return null;
    }
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw Object.assign(new Error("Requisição muito grande."), { status: 413 });
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
        throw Object.assign(new Error("O corpo da requisição deve conter JSON válido."), { status: 400 });
    }
}

function normalizeEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 32);
    return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

async function verifyPassword(password, stored) {
    const parts = String(stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    try {
        const salt = Buffer.from(parts[1], "base64url");
        const expected = Buffer.from(parts[2], "base64url");
        const actual = Buffer.from(await scrypt(password, salt, expected.length));
        return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

function cookieOptions(maxAge) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/health") {
        await pool.query("SELECT 1");
        return sendJson(response, 200, { status: "ok", database: "connected" });
    }

    if (request.method === "GET" && url.pathname === "/api/products") {
        const result = await pool.query(`
            SELECT p.id_produto, p.id_categoria, c.nome AS categoria,
                   p.nome, p.descricao, p.preco, p.estoque, p.condicao
            FROM produto p
            LEFT JOIN categoria c ON c.id_categoria = p.id_categoria
            ORDER BY p.id_produto
        `);
        return sendJson(response, 200, result.rows);
    }

    if (request.method === "POST" && url.pathname === "/api/customers") {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = normalizeEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        const phone = typeof body.phone === "string" ? body.phone.trim() : null;
        if (name.length < 3 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100 || password.length < 6 || password.length > 72 || (phone && phone.length > 20)) {
            return sendJson(response, 400, { error: "Confira nome, e-mail, telefone e senha." });
        }
        try {
            const passwordHash = await hashPassword(password);
            const result = await pool.query(
                "INSERT INTO cliente (nome, email, senha, telefone) VALUES ($1, $2, $3, $4) RETURNING id_cliente, nome, email",
                [name, email, passwordHash, phone || null]
            );
            return sendJson(response, 201, { customer: result.rows[0] });
        } catch (error) {
            if (error.code === "23505") return sendJson(response, 409, { error: "Este e-mail já está cadastrado." });
            throw error;
        }
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        const result = await pool.query(
            "SELECT id_cliente, nome, email, senha FROM cliente WHERE email = $1",
            [email]
        );
        const customer = result.rows[0];
        if (!customer || !(await verifyPassword(password, customer.senha))) {
            return sendJson(response, 401, { error: "E-mail ou senha incorretos." });
        }
        const cookie = `${sessionCookie}=${createSession(customer.id_cliente)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDuration}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
        return sendJson(response, 200, { customer: { id_cliente: customer.id_cliente, nome: customer.nome, email: customer.email } }, { "Set-Cookie": cookie });
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
        return sendJson(response, 200, { status: "ok" }, { "Set-Cookie": cookieOptions(0) });
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
        const customerId = readSession(request);
        if (!customerId) return sendJson(response, 401, { error: "Entre na sua conta para continuar." });
        const result = await pool.query(
            "SELECT id_cliente, nome, email FROM cliente WHERE id_cliente = $1",
            [customerId]
        );
        if (!result.rowCount) return sendJson(response, 401, { error: "Sessão inválida." });
        return sendJson(response, 200, { customer: result.rows[0] });
    }

    if (request.method === "POST" && url.pathname === "/api/orders") {
        const customerId = readSession(request);
        if (!customerId) return sendJson(response, 401, { error: "Entre na sua conta antes de finalizar o pedido." });
        const body = await readJson(request);
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
            return sendJson(response, 400, { error: "O carrinho não contém itens válidos." });
        }
        const quantities = new Map();
        for (const item of body.items) {
            const productId = Number(item && item.productId);
            const quantity = Number(item && item.quantity);
            if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
                return sendJson(response, 400, { error: "Confira os produtos e as quantidades do carrinho." });
            }
            quantities.set(productId, (quantities.get(productId) || 0) + quantity);
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const products = [];
            for (const [productId, quantity] of [...quantities.entries()].sort((a, b) => a[0] - b[0])) {
                const result = await client.query(
                    "SELECT id_produto, nome, preco, estoque FROM produto WHERE id_produto = $1 FOR UPDATE",
                    [productId]
                );
                const product = result.rows[0];
                if (!product) throw Object.assign(new Error("Um produto do carrinho não foi encontrado."), { status: 400 });
                if (product.estoque < quantity) throw Object.assign(new Error(`Estoque insuficiente para ${product.nome}.`), { status: 409 });
                products.push({ ...product, quantity });
            }
            const total = products.reduce((sum, product) => sum + Number(product.preco) * product.quantity, 0);
            const orderResult = await client.query(
                "INSERT INTO pedido (id_cliente, valor_total) VALUES ($1, $2) RETURNING id_pedido, data_pedido, valor_total, status",
                [customerId, total.toFixed(2)]
            );
            const order = orderResult.rows[0];
            for (const product of products) {
                await client.query(
                    "INSERT INTO item_pedido (id_pedido, id_produto, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)",
                    [order.id_pedido, product.id_produto, product.quantity, product.preco]
                );
                await client.query(
                    "UPDATE produto SET estoque = estoque - $1 WHERE id_produto = $2",
                    [product.quantity, product.id_produto]
                );
            }
            await client.query("COMMIT");
            return sendJson(response, 201, { order, items: products.map(({ id_produto, nome, preco, quantity }) => ({ id_produto, nome, preco, quantidade: quantity })) });
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.status) return sendJson(response, error.status, { error: error.message });
            throw error;
        } finally {
            client.release();
        }
    }

    return sendJson(response, 404, { error: "Endpoint não encontrado." });
}

function serveStatic(request, response, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        response.writeHead(400).end("Requisição inválida.");
        return;
    }
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || path.basename(file).startsWith(".")) {
        response.writeHead(404).end("Não encontrado.");
        return;
    }
    const types = {
        ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".svg": "image/svg+xml", ".ico": "image/x-icon"
    };
    if (!Object.hasOwn(types, path.extname(file).toLowerCase())) {
        response.writeHead(404).end("Não encontrado.");
        return;
    }
    fs.readFile(file, (error, contents) => {
        if (error) {
            response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Não foi possível abrir este arquivo.");
            return;
        }
        response.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()], "X-Content-Type-Options": "nosniff" });
        response.end(request.method === "HEAD" ? undefined : contents);
    });
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
        if (url.pathname.startsWith("/api/")) {
            await handleApi(request, response, url);
        } else if (request.method === "GET" || request.method === "HEAD") {
            serveStatic(request, response, url.pathname);
        } else {
            sendJson(response, 405, { error: "Método não permitido." }, { Allow: "GET, HEAD" });
        }
    } catch (error) {
        console.error(error.message);
        if (!response.headersSent) sendJson(response, 500, { error: "Erro interno do servidor. Confira a conexão com PostgreSQL." });
        else response.end();
    }
});

if (secret.length < 32) {
    console.error("Configure AUTH_SECRET com pelo menos 32 caracteres nas variáveis de ambiente.");
    process.exit(1);
}

async function startServer() {
    try {
        // The schema is idempotent, so hosted databases are initialized on first start
        // and kept in sync with schema.sql after future deployments.
        await pool.query(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
        server.listen(port, host, () => console.log(`TechStore disponível em http://localhost:${port}`));
    } catch (error) {
        console.error(`Não foi possível conectar ou preparar o PostgreSQL: ${error.message}`);
        await pool.end();
        process.exit(1);
    }
}

startServer();

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        server.close();
        await pool.end();
        process.exit(0);
    });
}
