const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { format } = require('date-fns');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');

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
    database: 'library_system',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
const upload = multer({ dest: 'uploads/' });

async function handleCardScan(uid) {
    const now = new Date();
    const currentDate = format(now, 'yyyy-MM-dd');
    const currentTime = format(now, 'HH:mm:ss');
    let eventData = { uid: uid };

    try {
        const [rfidRows] = await dbPool.query("SELECT user_id FROM rfid_details WHERE uid = ?", [uid]);
        if (rfidRows.length === 0) {
            eventData.status = 'UNREGISTERED';
            return io.emit('scan_event', eventData);
        }
        
        const user_id = rfidRows[0].user_id;
        eventData.user_id = user_id;
        const [userRows] = await dbPool.query("SELECT user_name FROM users WHERE user_id = ?", [user_id]);
        if (userRows.length === 0) {
            eventData.status = 'NO_DETAILS';
            return io.emit('scan_event', eventData);
        }
        
        eventData.user_name = userRows[0].user_name;
        const [openLogins] = await dbPool.query("SELECT log_id FROM attendance_log WHERE user_id = ? AND log_date = ? AND logout_time IS NULL LIMIT 1", [user_id, currentDate]);

        if (openLogins.length > 0) {
            await dbPool.query("UPDATE attendance_log SET logout_time = ? WHERE log_id = ?", [currentTime, openLogins[0].log_id]);
            eventData.status = 'LOGOUT';
            eventData.time = currentTime;
            io.emit('scan_event', eventData);
        } else {
            await dbPool.query("INSERT INTO attendance_log (user_id, log_date, login_time) VALUES (?, ?, ?)", [user_id, currentDate, currentTime]);
            eventData.status = 'LOGIN';
            eventData.time = currentTime;
            io.emit('scan_event', eventData);
            const counts = await getTodayBranchCounts();
            io.emit('counts_update', counts);
        }
    } catch (error) {
        console.error("Database/Logic Error:", error);
        eventData.status = 'ERROR';
        io.emit('scan_event', eventData);
    }
}

// MODIFIED: This function now groups counts by degree
async function getTodayBranchCounts() {
    const today = format(new Date(), 'yyyy-MM-dd');
    const [flatCounts] = await dbPool.query(
        `SELECT p.degree, p.branch_code, COUNT(al.log_id) as visit_count 
         FROM attendance_log al 
         JOIN users u ON al.user_id = u.user_id 
         JOIN programs p ON u.program_id = p.program_id 
         WHERE al.log_date = ? AND u.user_type = 'student' 
         GROUP BY p.degree, p.branch_code
         ORDER BY p.degree, p.branch_code`, 
        [today]
    );
    
    // Process the flat list into a nested object
    const groupedCounts = {};
    for (const row of flatCounts) {
        if (!groupedCounts[row.degree]) {
            groupedCounts[row.degree] = [];
        }
        groupedCounts[row.degree].push({
            branch_code: row.branch_code,
            visit_count: row.visit_count
        });
    }
    return groupedCounts;
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
                    uid: uid, 
                    status: 'IGNORED',
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

app.get('/', async (req, res) => {
    try {
        const today = format(new Date(), 'yyyy-MM-dd');
        const [todaysLog] = await dbPool.query(`SELECT al.user_id, al.login_time, al.logout_time, u.user_name FROM attendance_log al JOIN users u ON al.user_id = u.user_id WHERE al.log_date = ? ORDER BY al.login_time DESC`, [today]);
        const counts = await getTodayBranchCounts();
        res.render('dashboard', { logs: todaysLog, counts: counts });
    } catch (error) {
        console.error("Dashboard load error:", error);
        res.render('dashboard', { logs: [], counts: {} });
    }
});

app.get('/register', (req, res) => res.render('register', { messages: req.query }));

app.get('/manage-users', async (req, res) => {
    try {
        const [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name');
        const [departments] = await dbPool.query('SELECT * FROM departments ORDER BY department_name');
        res.render('manage-users', { 
            messages: req.query,
            programs: programs,
            departments: departments 
        });
    } catch (error) {
        res.render('manage-users', { messages: { error: 'Could not load page data.' }, programs: [], departments: [] });
    }
});

app.post('/add', async (req, res) => {
    const { user_id, uid } = req.body;
    if (!user_id || !uid) return res.redirect('/register?error=All fields are required.');
    try {
        await dbPool.query('INSERT INTO rfid_details (user_id, uid) VALUES (?, ?)', [user_id, uid]);
        res.redirect('/register?success=Registration successful!');
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.redirect('/register?error=Duplicate User ID or UID.');
        if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.redirect(`/register?error=User ID ${user_id} does not exist.`);
        res.redirect('/register?error=Database error.');
    }
});

app.post('/add-student-manual', async (req, res) => {
    const { user_id, user_name, year, program_id } = req.body;
    try {
        await dbPool.query(`INSERT INTO users (user_id, user_type, user_name, year, program_id) VALUES (?, 'student', ?, ?, ?)`, [user_id, user_name, year, program_id]);
        res.redirect('/manage-users?success=Student added successfully!');
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.redirect('/manage-users?error=Student with that ID already exists.');
        res.redirect('/manage-users?error=Failed to add student.');
    }
});

app.post('/upload-students-excel', upload.single('userFile'), async (req, res) => {
    if (!req.file) return res.redirect('/manage-users?error=No student Excel file was uploaded.');
    
    const connection = await dbPool.getConnection();
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.getWorksheet(1);
        
        const studentsToInsert = [];

        for (let i = 2; i <= worksheet.rowCount; i++) {
            const row = worksheet.getRow(i);
            const user_id = row.getCell(1).text;
            const user_name = row.getCell(2).text;
            const year = row.getCell(3).text;
            const degree = row.getCell(4).text;
            const branch_code = row.getCell(5).text;
            
            if (!user_id) continue;

            const [programRows] = await connection.query('SELECT program_id FROM programs WHERE degree = ? AND branch_code = ?', [degree, branch_code]);
            if (programRows.length === 0) {
                throw new Error(`Program not found for Degree '${degree}' with Branch Code '${branch_code}'.`);
            }
            
            const program_id = programRows[0].program_id;
            studentsToInsert.push([user_id, 'student', user_name, program_id, year]);
        }
        
        if (studentsToInsert.length > 0) {
            await connection.beginTransaction();
            const sql = `INSERT INTO users (user_id, user_type, user_name, program_id, year) VALUES ?`;
            await connection.query(sql, [studentsToInsert]);
            await connection.commit();
        }

        res.redirect(`/manage-users?success=${studentsToInsert.length} students uploaded!`);

    } catch (error) {
        if (connection) await connection.rollback();
        res.redirect(`/manage-users?error=${error.message}`);
    } finally {
        if (connection) connection.release();
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("Error deleting temp file:", err);
            });
        }
    }
});

app.post('/add-faculty-manual', async (req, res) => {
    const { user_id, user_name, designation, department_id } = req.body;
    try {
        await dbPool.query(`INSERT INTO users (user_id, user_type, user_name, designation, department_id) VALUES (?, 'faculty', ?, ?, ?)`, [user_id, user_name, designation, department_id]);
        res.redirect('/manage-users?success=Faculty added successfully!');
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.redirect('/manage-users?error=Faculty with that ID already exists.');
        res.redirect('/manage-users?error=Failed to add faculty.');
    }
});

app.post('/upload-faculty-excel', upload.single('userFile'), async (req, res) => {
    if (!req.file) return res.redirect('/manage-users?error=No faculty Excel file was uploaded.');

    const connection = await dbPool.getConnection();
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.getWorksheet(1);
        
        const facultyToInsert = [];
        
        for (let i = 2; i <= worksheet.rowCount; i++) {
            const row = worksheet.getRow(i);
            const user_id = row.getCell(1).text;
            const user_name = row.getCell(2).text;
            const department_name = row.getCell(3).text;
            const designation = row.getCell(4).text;

            if (!user_id) continue;
            
            const [deptRows] = await connection.query('SELECT department_id FROM departments WHERE department_name = ?', [department_name]);
            if (deptRows.length === 0) {
                throw new Error(`Department not found for ${department_name}.`);
            }
            const department_id = deptRows[0].department_id;
            
            facultyToInsert.push([user_id, 'faculty', user_name, department_id, designation]);
        }

        if (facultyToInsert.length > 0) {
            await connection.beginTransaction();
            const sql = `INSERT INTO users (user_id, user_type, user_name, department_id, designation) VALUES ?`;
            await connection.query(sql, [facultyToInsert]);
            await connection.commit();
        }

        res.redirect(`/manage-users?success=${facultyToInsert.length} faculty members uploaded!`);

    } catch (error) {
        if (connection) await connection.rollback();
        res.redirect(`/manage-users?error=${error.message}`);
    } finally {
        if (connection) connection.release();
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("Error deleting temp file:", err);
            });
        }
    }
});

async function autoLogoutCurrentDay() {
    const today = format(new Date(), 'yyyy-MM-dd');
    const logoutTime = '18:00:00';
    try {
        const [result] = await dbPool.query(
            `UPDATE attendance_log SET logout_time = ? WHERE log_date = ? AND logout_time IS NULL`,
            [logoutTime, today]
        );
        if (result.affectedRows > 0) {
            console.log(`Auto-logged out ${result.affectedRows} users for ${today}.`);
        }
    } catch (error) {
        console.error('Error during auto-logout:', error);
    }
}

async function cleanupPreviousDays() {
    const today = format(new Date(), 'yyyy-MM-dd');
    const logoutTime = '18:00:00';
    try {
        const [result] = await dbPool.query(
            `UPDATE attendance_log SET logout_time = ? WHERE log_date < ? AND logout_time IS NULL`,
            [logoutTime, today]
        );
        if (result.affectedRows > 0) {
            console.log(`Startup Cleanup: Logged out ${result.affectedRows} users from previous days.`);
        }
    } catch (error) {
        console.error('Error during cleanup of previous days:', error);
    }
}

cron.schedule('5 18 * * *', () => {
    console.log('Running scheduled job: Auto-logging out users for today...');
    autoLogoutCurrentDay();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});

server.listen(PORT, () => {
    console.log(`🚀 Server running! Dashboard is at http://localhost:${PORT}`);
    console.log('Running startup cleanup job for any missed logouts from previous days...');
    cleanupPreviousDays();
});

