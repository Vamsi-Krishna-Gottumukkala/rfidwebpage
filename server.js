// server.js (With name lookup and branch counting)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { format } = require('date-fns');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const scannedRecently = new Set();
const SCAN_TIMEOUT_MS = 5000;

const PORT = 3000;
const ARDUINO_PORT = 'COM14';

const dbPool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'rfid_attendance',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

async function handleCardScan(uid) {
    const now = new Date();
    const currentDate = format(now, 'yyyy-MM-dd');
    const currentTime = format(now, 'HH:mm:ss');
    let eventData = { uid: uid };

    try {
        const [rfidRows] = await dbPool.query("SELECT roll_no FROM rfid_details WHERE uid = ?", [uid]);
        if (rfidRows.length === 0) {
            eventData.status = 'UNREGISTERED';
            eventData.message = `Unregistered UID.`;
            return io.emit('scan_event', eventData);
        }
        
        const roll_no = rfidRows[0].roll_no;
        eventData.roll_no = roll_no;

        // NEW: Get student name and branch from the new table
        const [studentRows] = await dbPool.query("SELECT student_name, branch FROM students_with_branch WHERE roll_no = ?", [roll_no]);
        if (studentRows.length === 0) {
            eventData.status = 'NO_DETAILS';
            eventData.message = `Roll No ${roll_no} not found in student details.`;
            return io.emit('scan_event', eventData);
        }
        const { student_name, branch } = studentRows[0];
        eventData.student_name = student_name;

        // Check for an open login
        const [openLogins] = await dbPool.query(
            "SELECT id FROM attendance_log WHERE roll_no = ? AND log_date = ? AND logout_time IS NULL LIMIT 1",
            [roll_no, currentDate]
        );

        if (openLogins.length > 0) {
            const logId = openLogins[0].id;
            await dbPool.query("UPDATE attendance_log SET logout_time = ? WHERE id = ?", [currentTime, logId]);
            eventData.status = 'LOGOUT';
            eventData.time = currentTime;
        } else {
            // LOGIN Event
            await dbPool.query("INSERT INTO attendance_log (roll_no, log_date, login_time) VALUES (?, ?, ?)", [roll_no, currentDate, currentTime]);
            eventData.status = 'LOGIN';
            eventData.time = currentTime;

            // NEW: Update branch visit count
            await dbPool.query(
                `INSERT INTO branch_visits (visit_date, branch, visit_count) VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE visit_count = visit_count + 1`,
                [currentDate, branch]
            );

            // NEW: Fetch all of today's branch counts and broadcast them
            const [counts] = await dbPool.query("SELECT branch, visit_count FROM branch_visits WHERE visit_date = ?", [currentDate]);
            io.emit('counts_update', counts);
        }
        io.emit('scan_event', eventData);
    } catch (error) {
        console.error("Database/Logic Error:", error);
        eventData.status = 'ERROR';
        eventData.message = 'A server error occurred.';
        io.emit('scan_event', eventData);
    }
}

try {
    const port = new SerialPort({ path: ARDUINO_PORT, baudRate: 9600 });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    console.log(`Attempting to connect to Arduino on ${ARDUINO_PORT}...`);
    parser.on('data', (line) => {
        if (line.startsWith("RFID Tag UID:")) {
            const uid = line.split(":")[1].trim();
            if (scannedRecently.has(uid)) {
                io.emit('scan_event', {
                    uid: uid, status: 'IGNORED',
                    message: `Duplicate scan. Please wait ${SCAN_TIMEOUT_MS / 1000} seconds.`
                });
                return;
            }
            handleCardScan(uid);
            scannedRecently.add(uid);
            setTimeout(() => { scannedRecently.delete(uid); }, SCAN_TIMEOUT_MS);
        }
    });
    port.on('open', () => console.log(`Serial port ${ARDUINO_PORT} opened.`));
    port.on('error', (err) => console.error('SerialPort Error: ', err.message));
} catch (err) {
    console.error(`Could not connect to Arduino on port ${ARDUINO_PORT}.`);
}

// Main route for the live dashboard
app.get('/', async (req, res) => {
    try {
        const today = format(new Date(), 'yyyy-MM-dd');
        const [todaysLog] = await dbPool.query(
            "SELECT al.roll_no, al.login_time, al.logout_time, s.student_name FROM attendance_log al JOIN students_with_branch s ON al.roll_no = s.roll_no WHERE al.log_date = ? ORDER BY al.login_time DESC",
            [today]
        );
        const [counts] = await dbPool.query("SELECT branch, visit_count FROM branch_visits WHERE visit_date = ?", [today]);
        res.render('dashboard', { logs: todaysLog, counts: counts });
    } catch (error) {
        console.error("Dashboard load error:", error);
        res.render('dashboard', { logs: [], counts: [] });
    }
});

// Registration page is now at /register
app.get('/register', async (req, res) => {
    res.render('register', { messages: req.query });
});

// Form posts here and redirects back to /register
app.post('/add', async (req, res) => {
    const { roll_no, uid } = req.body;
    if (!roll_no || !uid) {
        return res.redirect('/register?error=All fields are required.');
    }
    try {
        await dbPool.query('INSERT INTO rfid_details (roll_no, uid) VALUES (?, ?)', [roll_no, uid]);
        res.redirect('/register?success=Registration successful!');
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.redirect('/register?error=Duplicate Roll No or UID.');
        }
        res.redirect('/register?error=Database error.');
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Server running! Dashboard is at http://localhost:${PORT}`);
});