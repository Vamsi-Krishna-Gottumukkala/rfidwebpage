// NEW: Load environment variables from .env file
require('dotenv').config();

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
const session = require('express-session');
const os = require('os'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const scannedRecently = new Set();
const SCAN_TIMEOUT_MS = 5000;

const PORT = 3000;
const ARDUINO_PORT = process.env.ARDUINO_PORT || 'COM17'; 

const networkInterfaces = os.networkInterfaces();
const localIp = Object.values(networkInterfaces)
  .flat()
  .find((iface) => iface.family === 'IPv4' && !iface.internal)?.address;

const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'library_system',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true 
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret_key_change_me', 
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } 
}));

app.use((req, res, next) => {
    res.locals.loggedIn = req.session.user ? true : false;
    res.locals.user = req.session.user;
    next();
});

const isAuthenticated = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login?error=Please login to access this page.');
    }
};

const upload = multer({ dest: 'uploads/' });

// --- Core Logic Functions ---
async function handleCardScan(uid) {
    const now = new Date(); const currentDate = format(now, 'yyyy-MM-dd'); const currentTime = format(now, 'HH:mm:ss'); let eventData = { uid: uid };
    try {
        const [rfidRows] = await dbPool.query("SELECT user_id FROM rfid_details WHERE uid = ?", [uid]); if (rfidRows.length === 0) { eventData.status = 'UNREGISTERED'; return io.emit('scan_event', eventData); }
        const user_id = rfidRows[0].user_id;
        const [userRows] = await dbPool.query(`SELECT u.*, p.degree, p.branch_name, p.branch_code, d.department_name FROM users u LEFT JOIN programs p ON u.program_id = p.program_id LEFT JOIN departments d ON u.department_id = d.department_id WHERE u.user_id = ?`, [user_id]);
        if (userRows.length === 0) { eventData.status = 'NO_DETAILS'; return io.emit('scan_event', eventData); }
        eventData.details = userRows[0];
        const [openLogins] = await dbPool.query("SELECT log_id FROM attendance_log WHERE user_id = ? AND log_date = ? AND logout_time IS NULL LIMIT 1", [user_id, currentDate]);
        if (openLogins.length > 0) { await dbPool.query("UPDATE attendance_log SET logout_time = ? WHERE log_id = ?", [currentTime, openLogins[0].log_id]); eventData.status = 'LOGOUT'; eventData.time = currentTime; io.emit('scan_event', eventData); }
        else { 
            const [result] = await dbPool.query("INSERT INTO attendance_log (user_id, log_date, login_time) VALUES (?, ?, ?)", [user_id, currentDate, currentTime]);
            eventData.details.log_id = result.insertId; 
            eventData.status = 'LOGIN'; 
            eventData.time = currentTime; 
            io.emit('scan_event', eventData); 
            const counts = await getTodayBranchCounts(); 
            io.emit('counts_update', counts); 
        }
    } catch (error) { console.error("DB/Logic Error:", error); eventData.status = 'ERROR'; io.emit('scan_event', eventData); }
}

// MODIFIED: Now calculates both student and faculty stats
async function getTodayBranchCounts() {
    const today = format(new Date(), 'yyyy-MM-dd'); 

    // 1. Get Student Counts
    const [studentCountsRaw] = await dbPool.query(`
        SELECT p.degree, p.branch_code, COUNT(al.log_id) as visit_count 
        FROM attendance_log al 
        JOIN users u ON al.user_id = u.user_id 
        JOIN programs p ON u.program_id = p.program_id 
        WHERE al.log_date = ? AND u.user_type = 'student' 
        GROUP BY p.degree, p.branch_code 
        ORDER BY p.degree, p.branch_code`, [today]);
    
    const groupedCounts = {};
    let totalStudentVisits = 0;

    for (const row of studentCountsRaw) {
        if (!groupedCounts[row.degree]) {
            groupedCounts[row.degree] = [];
        }
        groupedCounts[row.degree].push({
            branch_code: row.branch_code,
            visit_count: row.visit_count
        });
        totalStudentVisits += row.visit_count;
    }

    // 2. Get Faculty Counts (Grouped by Department)
    const [facultyCountsRaw] = await dbPool.query(`
        SELECT d.department_name, COUNT(al.log_id) as visit_count
        FROM attendance_log al
        JOIN users u ON al.user_id = u.user_id
        JOIN departments d ON u.department_id = d.department_id
        WHERE al.log_date = ? AND u.user_type = 'faculty'
        GROUP BY d.department_name
        ORDER BY d.department_name`, [today]);

    // Normalize faculty data to match the structure used by the charts
    const facultyCounts = facultyCountsRaw.map(row => ({
        branch_code: row.department_name, // Use department name as "branch code" for the chart label
        visit_count: row.visit_count
    }));

    return { groupedCounts, totalStudentVisits, facultyCounts };
}

// --- Serial Port ---
try {
    const port = new SerialPort({ path: ARDUINO_PORT, baudRate: 9600 }); const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' })); console.log(`Connecting to Arduino on ${ARDUINO_PORT}...`);
    parser.on('data', (line) => { if (line.startsWith("RFID Tag UID:")) { const uid = line.split(":")[1].trim(); if (scannedRecently.has(uid)) { io.emit('scan_event', { uid: uid, status: 'IGNORED', message: `Duplicate scan. Wait ${SCAN_TIMEOUT_MS / 1000}s.` }); return; } handleCardScan(uid); scannedRecently.add(uid); setTimeout(() => { scannedRecently.delete(uid); }, SCAN_TIMEOUT_MS); } });
    port.on('open', () => console.log(`Serial port ${ARDUINO_PORT} opened.`)); port.on('error', (err) => console.error('SerialPort Error: ', err.message));
} catch (err) { console.error(`Could not connect to Arduino on port ${ARDUINO_PORT}. Error: ${err.message}`); }

// --- Routes ---

app.get('/', (req, res) => { res.redirect('/dashboard'); });

app.get('/dashboard', async (req, res) => {
    try {
        const today = format(new Date(), 'yyyy-MM-dd');
        // Fetch log with user type info
        const [todaysLog] = await dbPool.query(`
            SELECT 
                al.log_id, al.user_id, al.login_time, al.logout_time, u.user_name, u.user_type,
                p.branch_name, u.year, d.department_name
            FROM attendance_log al 
            JOIN users u ON al.user_id = u.user_id 
            LEFT JOIN programs p ON u.program_id = p.program_id
            LEFT JOIN departments d ON u.department_id = d.department_id
            WHERE al.log_date = ?
            ORDER BY al.login_time DESC`, [today]);
        
        const { groupedCounts, totalStudentVisits, facultyCounts } = await getTodayBranchCounts();
        
        res.render('dashboard', { 
            logs: todaysLog, 
            counts: groupedCounts, 
            facultyCounts: facultyCounts, // Pass faculty data
            totalStudentVisits: totalStudentVisits 
        });
    } catch (error) {
        console.error("Dashboard load error:", error);
        res.render('dashboard', { logs: [], counts: {}, facultyCounts: [], totalStudentVisits: 0 });
    }
});

app.get('/register', (req, res) => { res.render('register', { messages: req.query }); });
app.post('/add', async (req, res) => { 
    const { user_id, uid } = req.body; if (!user_id || !uid) return res.redirect('/register?error=All fields are required.'); try { await dbPool.query('INSERT INTO rfid_details (user_id, uid) VALUES (?, ?)', [user_id, uid]); res.redirect('/register?success=Registration successful!'); } catch (err) { if (err.code === 'ER_DUP_ENTRY') return res.redirect('/register?error=Duplicate User ID or UID.'); if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.redirect(`/register?error=User ID ${user_id} does not exist.`); res.redirect('/register?error=Database error.'); }
});

// Login/Logout
app.get('/login', (req, res) => { if (req.session.user) return res.redirect('/home'); res.render('login', { messages: req.query }); });
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.redirect('/login?error=Username and password required.');
    try {
        const [rows] = await dbPool.query('SELECT username, password, role, user_id FROM credentials WHERE username = ?', [username]);
        if (rows.length === 0) return res.redirect('/login?error=Invalid username or password.');
        const user = rows[0];
        if (password === user.password) { // Insecure plain text check
            req.session.user = { username: user.username, role: user.role, linked_user_id: user.user_id };
            req.session.save((err) => { if (err) return res.redirect('/login?error=Session error.'); res.redirect('/home'); });
        } else { res.redirect('/login?error=Invalid username or password.'); }
    } catch (error) { console.error('Login error:', error); res.redirect('/login?error=Error during login.'); }
});
app.get('/logout', (req, res) => { req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); }); });

// --- Admin Routes ---
app.get('/home', isAuthenticated, (req, res) => { res.render('reports-landing'); });
app.get('/actions/:userType', isAuthenticated, (req, res) => { res.render('action-selection', { userType: req.params.userType }); });
app.get('/reports/student', isAuthenticated, async (req, res) => { try { const [branches] = await dbPool.query('SELECT DISTINCT branch_code, branch_name FROM programs ORDER BY branch_code'); res.render('report-generator', { userType: 'student', reportData: null, visitCounts: [], filters: null, error: req.query.error, branches: branches, departments: [] }); } catch (error) { res.render('report-generator', { userType: 'student', reportData: null, visitCounts: [], filters: null, error: 'Error loading branches.', branches: [], departments: [] }); } });
app.get('/reports/faculty', isAuthenticated, async (req, res) => { try { const [departments] = await dbPool.query('SELECT DISTINCT department_id, department_name FROM departments ORDER BY department_name'); res.render('report-generator', { userType: 'faculty', reportData: null, visitCounts: [], filters: null, error: req.query.error, branches: [], departments: departments }); } catch (error) { res.render('report-generator', { userType: 'faculty', reportData: null, visitCounts: [], filters: null, error: 'Error loading departments.', branches: [], departments: [] }); } });

app.post('/reports/preview', isAuthenticated, async (req, res) => {
    let { user_type, start_date, end_date, branch_code, department_id } = req.body;
    let detailQuery, countQuery; let params = [start_date, end_date]; let countParams = [start_date, end_date];
    let branches = []; let departments = [];
    if (user_type === 'student') {
        let detailWhere = `WHERE u.user_type = 'student' AND al.log_date BETWEEN ? AND ?`; let countWhere = `WHERE u.user_type = 'student' AND al.log_date BETWEEN ? AND ?`;
        if (branch_code) { const arr = Array.isArray(branch_code) ? branch_code : [branch_code]; if (arr.length > 0 && !arr.includes('all')) { detailWhere += ` AND p.branch_code IN (?)`; countWhere += ` AND p.branch_code IN (?)`; params.push(arr); countParams.push(arr); } }
        detailQuery = `SELECT al.user_id, u.user_name, p.branch_name as group_name, DATE_FORMAT(al.log_date, '%Y-%m-%d') as log_date, al.login_time, al.logout_time FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id ${detailWhere} ORDER BY al.log_date, al.login_time;`;
        countQuery = `SELECT p.degree, COUNT(al.log_id) as count FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id ${countWhere} GROUP BY p.degree ORDER BY p.degree;`;
        [branches] = await dbPool.query('SELECT DISTINCT branch_code, branch_name FROM programs ORDER BY branch_code');
    } else {
        let detailWhere = `WHERE u.user_type = 'faculty' AND al.log_date BETWEEN ? AND ?`; let countWhere = `WHERE u.user_type = 'faculty' AND al.log_date BETWEEN ? AND ?`;
        if (department_id) { const arr = Array.isArray(department_id) ? department_id : [department_id]; if (arr.length > 0 && !arr.includes('all')) { detailWhere += ` AND d.department_id IN (?)`; countWhere += ` AND d.department_id IN (?)`; params.push(arr); countParams.push(arr); } }
        detailQuery = `SELECT al.user_id, u.user_name, d.department_name as group_name, DATE_FORMAT(al.log_date, '%Y-%m-%d') as log_date, al.login_time, al.logout_time FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN departments d ON u.department_id = d.department_id ${detailWhere} ORDER BY al.log_date, al.login_time;`;
        countQuery = `SELECT d.department_name as group_name, COUNT(al.log_id) as count FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN departments d ON u.department_id = d.department_id ${countWhere} GROUP BY d.department_name ORDER BY d.department_name;`;
        [departments] = await dbPool.query('SELECT DISTINCT department_id, department_name FROM departments ORDER BY department_name');
    }
    try { const [reportData] = await dbPool.query(detailQuery, params); const [visitCounts] = await dbPool.query(countQuery, countParams); res.render('report-generator', { userType: user_type, reportData: reportData, visitCounts: visitCounts, filters: req.body, branches: branches, departments: departments }); }
    catch (error) { console.error("Report preview error:", error); res.render('report-generator', { userType: user_type, reportData: null, visitCounts: [], filters: req.body, error: 'Failed to generate report.', branches: branches, departments: departments }); }
});

app.post('/reports/download', isAuthenticated, async (req, res) => {
    let { user_type, start_date, end_date, branch_code, department_id } = req.body;
    if (branch_code && !Array.isArray(branch_code)) branch_code = [branch_code]; if (department_id && !Array.isArray(department_id)) department_id = [department_id];
    let query; let params = [start_date, end_date];
    if (user_type === 'student') {
        let where = `WHERE u.user_type = 'student' AND al.log_date BETWEEN ? AND ?`;
        if (branch_code && branch_code.length > 0 && !branch_code.includes('all')) { where += ` AND p.branch_code IN (?)`; params.push(branch_code); }
        query = `SELECT al.user_id, u.user_name, p.branch_name as group_name, DATE_FORMAT(al.log_date, '%Y-%m-%d') as log_date, TIME_FORMAT(al.login_time, '%H:%i:%s') as login_time, TIME_FORMAT(al.logout_time, '%H:%i:%s') as logout_time FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id ${where} ORDER BY al.log_date, al.login_time;`;
    } else {
        let where = `WHERE u.user_type = 'faculty' AND al.log_date BETWEEN ? AND ?`;
        if (department_id && department_id.length > 0 && !department_id.includes('all')) { where += ` AND d.department_id IN (?)`; params.push(department_id); }
        query = `SELECT al.user_id, u.user_name, d.department_name as group_name, DATE_FORMAT(al.log_date, '%Y-%m-%d') as log_date, TIME_FORMAT(al.login_time, '%H:%i:%s') as login_time, TIME_FORMAT(al.logout_time, '%H:%i:%s') as logout_time FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN departments d ON u.department_id = d.department_id ${where} ORDER BY al.log_date, al.login_time;`;
    }
    try { const [reportData] = await dbPool.query(query, params); const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Attendance Report'); worksheet.columns = [{ header: 'User ID', key: 'user_id', width: 20 }, { header: 'Name', key: 'user_name', width: 30 }, { header: (user_type === 'student' ? 'Branch' : 'Department'), key: 'group_name', width: 30 }, { header: 'Date', key: 'log_date', width: 15 }, { header: 'Login Time', key: 'login_time', width: 15 }, { header: 'Logout Time', key: 'logout_time', width: 15 }]; reportData.forEach(row => { const formattedRow = { ...row, logout_time: row.logout_time || 'N/A' }; worksheet.addRow(formattedRow); }); res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="Attendance_Report_${user_type}_${start_date}_to_${end_date}.xlsx"`); await workbook.xlsx.write(res); res.end();
    } catch (error) { console.error("Excel error:", error); res.status(500).send("Failed to generate Excel."); }
});

// Manage Pages
app.get('/manage-student', isAuthenticated, async (req, res) => { try { const [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name'); res.render('manage-student', { messages: req.query, programs: programs }); } catch (error) { res.render('manage-student', { messages: { error: 'Error loading page.' }, programs: [] }); } });
app.get('/manage-faculty', isAuthenticated, async (req, res) => { try { const [departments] = await dbPool.query('SELECT * FROM departments ORDER BY department_name'); res.render('manage-faculty', { messages: req.query, departments: departments }); } catch (error) { res.render('manage-faculty', { messages: { error: 'Error loading page.' }, departments: [] }); } });
app.get('/manage-student-details', isAuthenticated, async (req, res) => { try { const [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name'); res.render('manage-student-details', { messages: req.query, searchResult: null, programs: programs }); } catch (error) { res.render('manage-student-details', { messages: { error: 'Error loading programs.'}, searchResult: null, programs: [] }); } });
app.get('/manage-faculty-details', isAuthenticated, async (req, res) => { try { const [departments] = await dbPool.query('SELECT * FROM departments ORDER BY department_name'); res.render('manage-faculty-details', { messages: req.query, searchResult: null, departments: departments }); } catch (error) { res.render('manage-faculty-details', { messages: { error: 'Error loading departments.'}, searchResult: null, departments: [] }); } });

// Manage Actions
app.post('/add-student-manual', isAuthenticated, async (req, res) => { const { user_id, user_name, year, program_id } = req.body; try { await dbPool.query(`INSERT INTO users (user_id, user_type, user_name, year, program_id) VALUES (?, 'student', ?, ?, ?)`, [user_id, user_name, year, program_id]); res.redirect('/manage-student?success=Student added!'); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.redirect('/manage-student?error=ID exists.'); res.redirect('/manage-student?error=Failed.'); } });
app.post('/upload-students-excel', isAuthenticated, upload.single('userFile'), async (req, res) => { if (!req.file) return res.redirect('/manage-student?error=No file.'); const connection = await dbPool.getConnection(); try { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(req.file.path); const worksheet = workbook.getWorksheet(1); const studentsToInsert = []; for (let i = 2; i <= worksheet.rowCount; i++) { const row = worksheet.getRow(i); const user_id = row.getCell(1).text; const user_name = row.getCell(2).text; const year = row.getCell(3).text; const degree = row.getCell(4).text; const branch_code = row.getCell(5).text; if (!user_id) continue; const [programRows] = await connection.query('SELECT program_id FROM programs WHERE degree = ? AND branch_code = ?', [degree, branch_code]); if (programRows.length === 0) { throw new Error(`Program not found: ${degree}-${branch_code}.`); } studentsToInsert.push([user_id, 'student', user_name, programRows[0].program_id, year]); } if (studentsToInsert.length > 0) { await connection.beginTransaction(); await connection.query(`INSERT INTO users (user_id, user_type, user_name, program_id, year) VALUES ?`, [studentsToInsert]); await connection.commit(); } res.redirect(`/manage-student?success=${studentsToInsert.length} uploaded!`); } catch (error) { if (connection) await connection.rollback(); res.redirect(`/manage-student?error=${error.message}`); } finally { if (connection) connection.release(); if (req.file) fs.unlink(req.file.path, (err) => { if (err) console.error("Err delete temp:", err); }); } });
app.post('/add-faculty-manual', isAuthenticated, async (req, res) => { const { user_id, user_name, designation, department_id } = req.body; try { await dbPool.query(`INSERT INTO users (user_id, user_type, user_name, designation, department_id) VALUES (?, 'faculty', ?, ?, ?)`, [user_id, user_name, designation, department_id]); res.redirect('/manage-faculty?success=Faculty added!'); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.redirect('/manage-faculty?error=ID exists.'); res.redirect('/manage-faculty?error=Failed.'); } });
app.post('/upload-faculty-excel', isAuthenticated, upload.single('userFile'), async (req, res) => { if (!req.file) return res.redirect('/manage-faculty?error=No file.'); const connection = await dbPool.getConnection(); try { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(req.file.path); const worksheet = workbook.getWorksheet(1); const facultyToInsert = []; for (let i = 2; i <= worksheet.rowCount; i++) { const row = worksheet.getRow(i); const user_id = row.getCell(1).text; const user_name = row.getCell(2).text; const department_name = row.getCell(3).text; const designation = row.getCell(4).text; if (!user_id) continue; const [deptRows] = await connection.query('SELECT department_id FROM departments WHERE department_name = ?', [department_name]); if (deptRows.length === 0) { throw new Error(`Department not found: ${department_name}.`); } facultyToInsert.push([user_id, 'faculty', user_name, deptRows[0].department_id, designation]); } if (facultyToInsert.length > 0) { await connection.beginTransaction(); await connection.query(`INSERT INTO users (user_id, user_type, user_name, department_id, designation) VALUES ?`, [facultyToInsert]); await connection.commit(); } res.redirect(`/manage-faculty?success=${facultyToInsert.length} uploaded!`); } catch (error) { if (connection) await connection.rollback(); res.redirect(`/manage-faculty?error=${error.message}`); } finally { if (connection) connection.release(); if (req.file) fs.unlink(req.file.path, (err) => { if (err) console.error("Err delete temp:", err); }); } });

// Search and Update User
app.post('/user/search', isAuthenticated, async (req, res) => {
    const { user_id_search, user_type } = req.body;
    const managePage = user_type === 'student' ? 'manage-student-details' : 'manage-faculty-details';
    if (!user_id_search) return res.redirect(`/${managePage}?error=Enter ID.`);
    try {
        const [userRows] = await dbPool.query('SELECT * FROM users WHERE user_id = ? AND user_type = ?', [user_id_search, user_type]);
        if (userRows.length === 0) return res.redirect(`/${managePage}?error=User not found.`);
        const user = userRows[0];
        let programs = [], departments = [];
        if (user_type === 'student') [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name');
        else [departments] = await dbPool.query('SELECT * FROM departments ORDER BY department_name');
        res.render(managePage, { messages: { success: 'User found.' }, searchResult: user, programs, departments });
    } catch (error) { console.error(error); res.redirect(`/${managePage}?error=Error searching.`); }
});
app.post('/user/update', isAuthenticated, async (req, res) => {
    const { user_id, user_name, user_type, year, program_id, designation, department_id } = req.body;
    const managePage = user_type === 'student' ? 'manage-student-details' : 'manage-faculty-details';
    try {
        if (user_type === 'student') await dbPool.query('UPDATE users SET user_name=?, year=?, program_id=? WHERE user_id=? AND user_type=?', [user_name, year, program_id, user_id, 'student']);
        else await dbPool.query('UPDATE users SET user_name=?, designation=?, department_id=? WHERE user_id=? AND user_type=?', [user_name, designation, department_id, user_id, 'faculty']);
        res.redirect(`/${managePage}?success=User updated.`);
    } catch (error) { console.error(error); res.redirect(`/${managePage}?error=Update failed.`); }
});

// NEW: Individual Delete Route
app.post('/user/delete', isAuthenticated, async (req, res) => {
    const { user_id, user_type } = req.body;
    const managePage = user_type === 'student' ? 'manage-student-details' : 'manage-faculty-details';
    const connection = await dbPool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM rfid_details WHERE user_id = ?', [user_id]);
        await connection.query('DELETE FROM attendance_log WHERE user_id = ?', [user_id]);
        await connection.query('DELETE FROM users WHERE user_id = ?', [user_id]);
        await connection.commit();
        res.redirect(`/${managePage}?success=User ${user_id} deleted successfully.`);
    } catch (error) {
        await connection.rollback();
        console.error("Delete error:", error);
        res.redirect(`/${managePage}?error=Failed to delete user.`);
    } finally { connection.release(); }
});

// Mass Delete
app.post('/delete-students-mass', isAuthenticated, async (req, res) => {
    const { program_id, year, verification } = req.body;
    if (verification !== 'confirm delete') return res.redirect('/manage-student-details?error=Verification failed.');
    const connection = await dbPool.getConnection();
    try {
        await connection.beginTransaction();
        const [users] = await connection.query('SELECT user_id FROM users WHERE user_type="student" AND program_id=? AND year=?', [program_id, year]);
        if (users.length === 0) throw new Error('No students found.');
        const ids = users.map(u => u.user_id);
        await connection.query('DELETE FROM rfid_details WHERE user_id IN (?)', [ids]);
        await connection.query('DELETE FROM attendance_log WHERE user_id IN (?)', [ids]);
        const [resDel] = await connection.query('DELETE FROM users WHERE user_id IN (?)', [ids]);
        await connection.commit();
        res.redirect(`/manage-student-details?success=${resDel.affectedRows} students deleted.`);
    } catch (error) { await connection.rollback(); res.redirect(`/manage-student-details?error=${error.message}`); } finally { connection.release(); }
});

// Programs & Depts
app.get('/manage-programs', isAuthenticated, async (req, res) => { try { const [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name'); res.render('manage-programs', { messages: req.query, programs: programs }); } catch (error) { res.render('manage-programs', { messages: { error: 'Could not load programs.' }, programs: [] }); } });
app.post('/manage-programs/add', isAuthenticated, async (req, res) => { const { degree, branch_name, branch_code } = req.body; try { await dbPool.query('INSERT INTO programs (degree, branch_name, branch_code) VALUES (?, ?, ?)', [degree.trim(), branch_name.trim(), branch_code.trim().toUpperCase()]); res.redirect('/manage-programs?success=Program added!'); } catch (error) { res.redirect('/manage-programs?error=Failed to add.'); } });
app.post('/manage-programs/delete/:id', isAuthenticated, async (req, res) => { const programId = req.params.id; try { const [check] = await dbPool.query('SELECT COUNT(*) as c FROM users WHERE program_id = ?', [programId]); if (check[0].c > 0) return res.redirect(`/manage-programs?error=Cannot delete: ${check[0].c} students assigned.`); await dbPool.query('DELETE FROM programs WHERE program_id = ?', [programId]); res.redirect('/manage-programs?success=Deleted!'); } catch (error) { res.redirect('/manage-programs?error=Failed.'); } });
app.get('/manage-departments', isAuthenticated, async (req, res) => { try { const [departments] = await dbPool.query('SELECT * FROM departments ORDER BY department_name'); res.render('manage-departments', { messages: req.query, departments: departments }); } catch (error) { res.render('manage-departments', { messages: { error: 'Could not load departments.' }, departments: [] }); } });
app.post('/manage-departments/add', isAuthenticated, async (req, res) => { const { department_name } = req.body; try { await dbPool.query('INSERT INTO departments (department_name) VALUES (?)', [department_name.trim()]); res.redirect('/manage-departments?success=Added!'); } catch (error) { res.redirect('/manage-departments?error=Failed.'); } });
app.post('/manage-departments/delete/:id', isAuthenticated, async (req, res) => { const id = req.params.id; try { const [check] = await dbPool.query('SELECT COUNT(*) as c FROM users WHERE department_id = ?', [id]); if (check[0].c > 0) return res.redirect(`/manage-departments?error=Cannot delete: ${check[0].c} faculty assigned.`); await dbPool.query('DELETE FROM departments WHERE department_id = ?', [id]); res.redirect('/manage-departments?success=Deleted!'); } catch (error) { res.redirect('/manage-departments?error=Failed.'); } });
app.get('/edit-rfid', isAuthenticated, async (req, res) => { res.render('edit-rfid', { messages: req.query, searchResult: null, backUserType: req.query.from || 'student' }); });
app.post('/edit-rfid/search', isAuthenticated, async (req, res) => { const { user_id_search } = req.body; try { const [u] = await dbPool.query('SELECT * FROM users WHERE user_id=?', [user_id_search]); if (u.length===0) return res.render('edit-rfid', {messages:{error:'Not found'}, searchResult:null}); const [r] = await dbPool.query('SELECT uid FROM rfid_details WHERE user_id=?', [user_id_search]); res.render('edit-rfid', {messages:req.query, searchResult:{...u[0], currentUid: r.length>0?r[0].uid:null}, backUserType:u[0].user_type}); } catch(e){ res.render('edit-rfid', {messages:{error:'Error'}, searchResult:null}); } });
app.post('/edit-rfid/update', isAuthenticated, async (req, res) => { const { user_id, new_uid, back_user_type } = req.body; const conn = await dbPool.getConnection(); try { await conn.beginTransaction(); if(new_uid) { const [ex] = await conn.query('SELECT user_id FROM rfid_details WHERE uid=? AND user_id!=?', [new_uid, user_id]); if(ex.length>0) throw new Error('UID assigned'); } await conn.query('DELETE FROM rfid_details WHERE user_id=?', [user_id]); if(new_uid) await conn.query('INSERT INTO rfid_details VALUES (?,?)', [new_uid, user_id]); await conn.commit(); res.redirect(`/edit-rfid?from=${back_user_type}&success=Updated.`); } catch(e){ await conn.rollback(); res.redirect(`/edit-rfid?from=${back_user_type}&error=${e.message}`); } finally { conn.release(); } });
app.post('/logout-user', isAuthenticated, async (req, res) => { try { await dbPool.query("UPDATE attendance_log SET logout_time = ? WHERE log_id = ? AND logout_time IS NULL", [format(new Date(), 'HH:mm:ss'), req.body.log_id]); res.redirect('/dashboard?success=Logged out.'); } catch (e) { res.redirect('/dashboard?error=Failed.'); } });
app.post('/logout-all', isAuthenticated, async (req, res) => { try { const [r] = await dbPool.query("UPDATE attendance_log SET logout_time = ? WHERE log_date = ? AND logout_time IS NULL AND user_type='student'", [format(new Date(), 'HH:mm:ss'), format(new Date(), 'yyyy-MM-dd')]); res.redirect(`/dashboard?success=${r.affectedRows} logged out.`); } catch (e) { res.redirect('/dashboard?error=Failed.'); } });
app.get('/credits', (req, res) => res.render('credits'));

// Scheduled Tasks
async function autoLogoutCurrentDay() { try { await dbPool.query(`UPDATE attendance_log SET logout_time = '19:00:00' WHERE log_date = ? AND logout_time IS NULL`, [format(new Date(), 'yyyy-MM-dd')]); } catch (e) { console.error(e); } }
async function cleanupPreviousDays() { try { await dbPool.query(`UPDATE attendance_log SET logout_time = '19:00:00' WHERE log_date < ? AND logout_time IS NULL`, [format(new Date(), 'yyyy-MM-dd')]); } catch (e) { console.error(e); } }
cron.schedule('5 19 * * *', () => { autoLogoutCurrentDay(); }, { scheduled: true, timezone: "Asia/Kolkata" });

server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running at http://localhost:${PORT}/dashboard`); cleanupPreviousDays(); });