const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { format } = require('date-fns'); // Standard date-fns functions are okay
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');
const session = require('express-session');
// const bcrypt = require('bcrypt'); // Removed bcrypt

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const scannedRecently = new Set();
const SCAN_TIMEOUT_MS = 5000;

const PORT = 3000;
const ARDUINO_PORT = 'COM14'; // Make sure this is correct

const dbPool = mysql.createPool({
    host: 'localhost', user: 'root', password: '', database: 'library_system',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0,
    dateStrings: true
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- Session Configuration ---
app.use(session({
    secret: 'a_different_secret_key_please_change', // CHANGE THIS! Use a long random string
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true, // Prevent client-side JS access
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Middleware to pass login status to all views
app.use((req, res, next) => {
    res.locals.loggedIn = req.session.user ? true : false;
    res.locals.user = req.session.user;
    // Add log to check session on every request
    // console.log(`[${new Date().toLocaleTimeString()}] Request for ${req.path}, Session User:`, req.session.user);
    next();
});

// --- Authentication Middleware ---
const isAuthenticated = (req, res, next) => {
    console.log(`[Auth Check] Path: ${req.path}, Session User:`, req.session.user); // Log session check
    if (req.session.user) {
        next(); // User is logged in, proceed
    } else {
        console.log('[Auth Check] Redirecting to login.'); // Log redirect reason
        res.redirect('/login?error=Please login to access this page.'); // Not logged in, redirect
    }
};

const upload = multer({ dest: 'uploads/' });

// --- Core Logic Functions (handleCardScan, getTodayBranchCounts) ---
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
        else { await dbPool.query("INSERT INTO attendance_log (user_id, log_date, login_time) VALUES (?, ?, ?)", [user_id, currentDate, currentTime]); eventData.status = 'LOGIN'; eventData.time = currentTime; io.emit('scan_event', eventData); const counts = await getTodayBranchCounts(); io.emit('counts_update', counts); }
    } catch (error) { console.error("DB/Logic Error:", error); eventData.status = 'ERROR'; io.emit('scan_event', eventData); }
}
async function getTodayBranchCounts() {
    const today = format(new Date(), 'yyyy-MM-dd'); const [flatCounts] = await dbPool.query(`SELECT p.degree, p.branch_code, COUNT(al.log_id) as visit_count FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id WHERE al.log_date = ? AND u.user_type = 'student' GROUP BY p.degree, p.branch_code ORDER BY p.degree, p.branch_code`, [today]);
    const groupedCounts = {}; for (const row of flatCounts) { if (!groupedCounts[row.degree]) { groupedCounts[row.degree] = []; } groupedCounts[row.degree].push({ branch_code: row.branch_code, visit_count: row.visit_count }); } return groupedCounts;
}

// --- Serial Port Connection ---
try {
    const port = new SerialPort({ path: ARDUINO_PORT, baudRate: 9600 }); const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' })); console.log(`Connecting to Arduino on ${ARDUINO_PORT}...`);
    parser.on('data', (line) => { if (line.startsWith("RFID Tag UID:")) { const uid = line.split(":")[1].trim(); if (scannedRecently.has(uid)) { io.emit('scan_event', { uid: uid, status: 'IGNORED', message: `Duplicate scan. Wait ${SCAN_TIMEOUT_MS / 1000}s.` }); return; } handleCardScan(uid); scannedRecently.add(uid); setTimeout(() => { scannedRecently.delete(uid); }, SCAN_TIMEOUT_MS); } });
    port.on('open', () => console.log(`Serial port ${ARDUINO_PORT} opened.`)); port.on('error', (err) => console.error('SerialPort Error: ', err.message));
} catch (err) { console.error(`Could not connect to Arduino on port ${ARDUINO_PORT}. Error: ${err.message}`); }

// --- Web Routes ---

// Root redirects to the public dashboard
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// --- Public Routes ---

app.get('/dashboard', async (req, res) => {
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

app.get('/register', (req, res) => {
    res.render('register', { messages: req.query });
});

app.post('/add', async (req, res) => { // Consider adding isAuthenticated if only admins can register
    const { user_id, uid } = req.body;
    if (!user_id || !uid) return res.redirect('/register?error=All fields are required.');
    try { await dbPool.query('INSERT INTO rfid_details (user_id, uid) VALUES (?, ?)', [user_id, uid]); res.redirect('/register?success=Registration successful!'); }
    catch (err) { if (err.code === 'ER_DUP_ENTRY') return res.redirect('/register?error=Duplicate User ID or UID.'); if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.redirect(`/register?error=User ID ${user_id} does not exist.`); res.redirect('/register?error=Database error.'); }
});

// --- Login/Logout ---
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/home');
    res.render('login', { messages: req.query });
});

// MODIFIED: Added logging and alternative session saving
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`[Login Attempt] User: ${username}`); // Log attempt
    if (!username || !password) {
        return res.redirect('/login?error=Username and password are required.');
    }
    try {
        const [rows] = await dbPool.query('SELECT username, password, role, user_id FROM credentials WHERE username = ?', [username]);
        if (rows.length === 0) {
            console.log(`[Login Failed] User not found: ${username}`);
            return res.redirect('/login?error=Invalid username or password.');
        }
        const user = rows[0];

        // --- Plain Text Password Check (INSECURE) ---
        if (password === user.password) {
            console.log(`[Login Success] User: ${username}`);
            // --- End Direct Comparison ---

            // Store user info directly in the session
            req.session.user = { username: user.username, role: user.role, linked_user_id: user.user_id };

            // Save the session explicitly before redirecting
            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.redirect('/login?error=Session error during save.');
                }
                console.log(`[Login Success] Session saved for ${username}. Redirecting to /home.`);
                res.redirect('/home'); // Redirect AFTER session is saved
            });

            // Using regenerate (alternative, keep one of the methods - save or regenerate)
            /*
            req.session.regenerate((err) => {
                 if (err) {
                     console.error('Session regeneration error:', err);
                     return res.redirect('/login?error=Session error during regenerate.');
                 }
                 // Set user data AFTER regenerating
                 req.session.user = { username: user.username, role: user.role, linked_user_id: user.user_id };
                 console.log(`[Login Success] Session regenerated for ${username}. User data set.`);

                 // Save again after setting data in regenerated session
                 req.session.save((saveErr) => {
                    if (saveErr) {
                         console.error('Session save after regenerate error:', saveErr);
                         return res.redirect('/login?error=Session error after regenerate.');
                    }
                    console.log(`[Login Success] Regenerated session saved for ${username}. Redirecting to /home.`);
                    res.redirect('/home');
                 });
            });
            */
        } else {
            console.log(`[Login Failed] Invalid password for user: ${username}`);
            res.redirect('/login?error=Invalid username or password.');
        }
    } catch (error) {
        console.error('[Login Error] Database or other error:', error);
        res.redirect('/login?error=An error occurred during login.');
    }
});


app.get('/logout', (req, res) => {
    const username = req.session.user ? req.session.user.username : 'Unknown';
    console.log(`[Logout Attempt] User: ${username}`);
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout error:", err);
            // Still try to clear cookie and redirect
        }
        res.clearCookie('connect.sid'); // The default session cookie name
        console.log(`[Logout Success] Session destroyed for ${username}. Redirecting to /login.`);
        res.redirect('/login');
    });
});


// --- Admin Routes (Protected by isAuthenticated) ---

app.get('/home', isAuthenticated, (req, res) => {
    res.render('reports-landing');
});

app.get('/actions/:userType', isAuthenticated, (req, res) => {
    const userType = req.params.userType;
    if (userType !== 'student' && userType !== 'faculty') return res.status(404).send('Invalid user type.');
    res.render('action-selection', { userType });
});

app.get('/reports/student', isAuthenticated, (req, res) => {
    res.render('report-generator', { userType: 'student', reportData: null, visitCounts: [], filters: null, error: req.query.error });
});
app.get('/reports/faculty', isAuthenticated, (req, res) => {
    res.render('report-generator', { userType: 'faculty', reportData: null, visitCounts: [], filters: null, error: req.query.error });
});

app.post('/reports/preview', isAuthenticated, async (req, res) => {
    const { user_type, start_date, end_date } = req.body; let detailQuery, countQuery; let params = [start_date, end_date];
    if (user_type === 'student') { detailQuery = `SELECT al.*, u.user_name, p.branch_name as group_name FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id WHERE u.user_type = 'student' AND al.log_date BETWEEN ? AND ? ORDER BY al.log_date, al.login_time;`; countQuery = `SELECT p.degree, COUNT(al.log_id) as count FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id WHERE u.user_type = 'student' AND al.log_date BETWEEN ? AND ? GROUP BY p.degree ORDER BY p.degree;`; }
    else { detailQuery = `SELECT al.*, u.user_name, d.department_name as group_name FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN departments d ON u.department_id = d.department_id WHERE u.user_type = 'faculty' AND al.log_date BETWEEN ? AND ? ORDER BY al.log_date, al.login_time;`; countQuery = `SELECT d.department_name as group_name, COUNT(al.log_id) as count FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN departments d ON u.department_id = d.department_id WHERE u.user_type = 'faculty' AND al.log_date BETWEEN ? AND ? GROUP BY d.department_name ORDER BY d.department_name;`; }
    try { const [reportData] = await dbPool.query(detailQuery, params); const [visitCounts] = await dbPool.query(countQuery, params); res.render('report-generator', { userType: user_type, reportData: reportData, visitCounts: visitCounts, filters: req.body }); }
    catch (error) { console.error("Report preview error:", error); res.redirect(`/reports/${user_type}?error=Failed to generate report.`); }
});

app.post('/reports/download', isAuthenticated, async (req, res) => {
    const { user_type, start_date, end_date } = req.body; let query; let params = [start_date, end_date];
    if (user_type === 'student') { query = `SELECT al.user_id, u.user_name, p.branch_name as group_name, DATE_FORMAT(al.log_date, '%Y-%m-%d') as log_date, TIME_FORMAT(al.login_time, '%H:%i:%s') as login_time, TIME_FORMAT(al.logout_time, '%H:%i:%s') as logout_time FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN programs p ON u.program_id = p.program_id WHERE u.user_type = 'student' AND al.log_date BETWEEN ? AND ? ORDER BY al.log_date, al.login_time;`; } else { query = `SELECT al.user_id, u.user_name, d.department_name as group_name, DATE_FORMAT(al.log_date, '%Y-%m-%d') as log_date, TIME_FORMAT(al.login_time, '%H:%i:%s') as login_time, TIME_FORMAT(al.logout_time, '%H:%i:%s') as logout_time FROM attendance_log al JOIN users u ON al.user_id = u.user_id JOIN departments d ON u.department_id = d.department_id WHERE u.user_type = 'faculty' AND al.log_date BETWEEN ? AND ? ORDER BY al.log_date, al.login_time;`; }
    try { const [reportData] = await dbPool.query(query, params); const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Attendance Report'); worksheet.columns = [{ header: 'User ID', key: 'user_id', width: 20 }, { header: 'Name', key: 'user_name', width: 30 }, { header: (user_type === 'student' ? 'Branch' : 'Department'), key: 'group_name', width: 30 }, { header: 'Date', key: 'log_date', width: 15 }, { header: 'Login Time', key: 'login_time', width: 15 }, { header: 'Logout Time', key: 'logout_time', width: 15 }];
        reportData.forEach(row => { const formattedRow = { ...row, logout_time: row.logout_time || 'N/A' }; worksheet.addRow(formattedRow); });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="Attendance_Report_${user_type}_${start_date}_to_${end_date}.xlsx"`); await workbook.xlsx.write(res); res.end();
    } catch (error) { console.error("Excel download error:", error); res.status(500).send("Failed to generate Excel file."); }
});

// Separate User Management Pages
app.get('/manage-student', isAuthenticated, async (req, res) => {
    try { const [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name'); res.render('manage-student', { messages: req.query, programs: programs }); } catch (error) { res.render('manage-student', { messages: { error: 'Could not load page data.' }, programs: [] }); }
});
app.get('/manage-faculty', isAuthenticated, async (req, res) => {
     try { const [departments] = await dbPool.query('SELECT * FROM departments ORDER BY department_name'); res.render('manage-faculty', { messages: req.query, departments: departments }); } catch (error) { res.render('manage-faculty', { messages: { error: 'Could not load page data.' }, departments: [] }); }
});

// User Management POST Actions
app.post('/add-student-manual', isAuthenticated, async (req, res) => {
    const { user_id, user_name, year, program_id } = req.body; try { await dbPool.query(`INSERT INTO users (user_id, user_type, user_name, year, program_id) VALUES (?, 'student', ?, ?, ?)`, [user_id, user_name, year, program_id]); res.redirect('/manage-student?success=Student added!'); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.redirect('/manage-student?error=ID exists.'); res.redirect('/manage-student?error=Failed.'); }
});
app.post('/upload-students-excel', isAuthenticated, upload.single('userFile'), async (req, res) => {
    if (!req.file) return res.redirect('/manage-student?error=No file.'); const connection = await dbPool.getConnection(); try { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(req.file.path); const worksheet = workbook.getWorksheet(1); const studentsToInsert = [];
        for (let i = 2; i <= worksheet.rowCount; i++) { const row = worksheet.getRow(i); const user_id = row.getCell(1).text; const user_name = row.getCell(2).text; const year = row.getCell(3).text; const degree = row.getCell(4).text; const branch_code = row.getCell(5).text; if (!user_id) continue; const [programRows] = await connection.query('SELECT program_id FROM programs WHERE degree = ? AND branch_code = ?', [degree, branch_code]); if (programRows.length === 0) { throw new Error(`Program not found: ${degree}-${branch_code}.`); } studentsToInsert.push([user_id, 'student', user_name, programRows[0].program_id, year]); }
        if (studentsToInsert.length > 0) { await connection.beginTransaction(); await connection.query(`INSERT INTO users (user_id, user_type, user_name, program_id, year) VALUES ?`, [studentsToInsert]); await connection.commit(); } res.redirect(`/manage-student?success=${studentsToInsert.length} uploaded!`);
    } catch (error) { if (connection) await connection.rollback(); res.redirect(`/manage-student?error=${error.message}`); } finally { if (connection) connection.release(); if (req.file) fs.unlink(req.file.path, (err) => { if (err) console.error("Err delete temp:", err); }); }
});
app.post('/add-faculty-manual', isAuthenticated, async (req, res) => {
    const { user_id, user_name, designation, department_id } = req.body; try { await dbPool.query(`INSERT INTO users (user_id, user_type, user_name, designation, department_id) VALUES (?, 'faculty', ?, ?, ?)`, [user_id, user_name, designation, department_id]); res.redirect('/manage-faculty?success=Faculty added!'); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.redirect('/manage-faculty?error=ID exists.'); res.redirect('/manage-faculty?error=Failed.'); }
});
app.post('/upload-faculty-excel', isAuthenticated, upload.single('userFile'), async (req, res) => {
     if (!req.file) return res.redirect('/manage-faculty?error=No file.'); const connection = await dbPool.getConnection(); try { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(req.file.path); const worksheet = workbook.getWorksheet(1); const facultyToInsert = [];
        for (let i = 2; i <= worksheet.rowCount; i++) { const row = worksheet.getRow(i); const user_id = row.getCell(1).text; const user_name = row.getCell(2).text; const department_name = row.getCell(3).text; const designation = row.getCell(4).text; if (!user_id) continue; const [deptRows] = await connection.query('SELECT department_id FROM departments WHERE department_name = ?', [department_name]); if (deptRows.length === 0) { throw new Error(`Department not found: ${department_name}.`); } facultyToInsert.push([user_id, 'faculty', user_name, deptRows[0].department_id, designation]); }
        if (facultyToInsert.length > 0) { await connection.beginTransaction(); await connection.query(`INSERT INTO users (user_id, user_type, user_name, department_id, designation) VALUES ?`, [facultyToInsert]); await connection.commit(); } res.redirect(`/manage-faculty?success=${facultyToInsert.length} uploaded!`);
    } catch (error) { if (connection) await connection.rollback(); res.redirect(`/manage-faculty?error=${error.message}`); } finally { if (connection) connection.release(); if (req.file) fs.unlink(req.file.path, (err) => { if (err) console.error("Err delete temp:", err); }); }
});

// Edit RFID Routes
app.get('/edit-rfid', isAuthenticated, async (req, res) => {
    res.render('edit-rfid', { messages: req.query, searchResult: null });
});
app.post('/edit-rfid/search', isAuthenticated, async (req, res) => {
    const { user_id_search } = req.body; if (!user_id_search) return res.render('edit-rfid', { messages: { error: 'Please enter a User ID.' }, searchResult: null });
    try { const [userRows] = await dbPool.query('SELECT user_id, user_name, user_type FROM users WHERE user_id = ?', [user_id_search]); if (userRows.length === 0) return res.render('edit-rfid', { messages: { error: `User ID '${user_id_search}' not found.` }, searchResult: null }); const user = userRows[0]; const [rfidRows] = await dbPool.query('SELECT uid FROM rfid_details WHERE user_id = ?', [user_id_search]); const currentUid = rfidRows.length > 0 ? rfidRows[0].uid : null; res.render('edit-rfid', { messages: req.query, searchResult: { ...user, currentUid } }); } catch (error) { console.error("RFID Search Error:", error); res.render('edit-rfid', { messages: { error: 'Error searching.' }, searchResult: null }); }
});
app.post('/edit-rfid/update', isAuthenticated, async (req, res) => {
    const { user_id, new_uid } = req.body; if (!user_id) return res.redirect('/edit-rfid?error=User ID missing.');
    const connection = await dbPool.getConnection(); try { await connection.beginTransaction();
        if (new_uid) { const [existingUidRows] = await connection.query('SELECT user_id FROM rfid_details WHERE uid = ? AND user_id != ?', [new_uid, user_id]); if (existingUidRows.length > 0) throw new Error(`UID '${new_uid}' already assigned to ${existingUidRows[0].user_id}.`); }
        await connection.query('DELETE FROM rfid_details WHERE user_id = ?', [user_id]);
        if (new_uid) { await connection.query('INSERT INTO rfid_details (user_id, uid) VALUES (?, ?)', [user_id, new_uid]); }
        await connection.commit(); res.redirect(`/edit-rfid?success=Updated RFID for ${user_id}.`);
    } catch (error) { await connection.rollback(); console.error("RFID Update Error:", error); res.redirect(`/edit-rfid?error=${encodeURIComponent(error.message || 'Update failed.')}&user_id_search=${encodeURIComponent(user_id)}`); } finally { connection.release(); }
});

// Manage Programs Routes
app.get('/manage-programs', isAuthenticated, async (req, res) => {
    try { const [programs] = await dbPool.query('SELECT * FROM programs ORDER BY degree, branch_name'); res.render('manage-programs', { messages: req.query, programs: programs }); } catch (error) { console.error("Error fetching programs:", error); res.render('manage-programs', { messages: { error: 'Could not load programs.' }, programs: [] }); }
});
app.post('/manage-programs/add', isAuthenticated, async (req, res) => {
    const { degree, branch_name, branch_code } = req.body; if (!degree || !branch_name || !branch_code) return res.redirect('/manage-programs?error=All fields required.');
    try { await dbPool.query('INSERT INTO programs (degree, branch_name, branch_code) VALUES (?, ?, ?)', [degree.trim(), branch_name.trim(), branch_code.trim().toUpperCase()]); res.redirect('/manage-programs?success=Program added!'); } catch (error) { if (error.code === 'ER_DUP_ENTRY') { if (error.sqlMessage.includes('uk_program')) return res.redirect(`/manage-programs?error=Duplicate Degree/Branch: ${degree}-${branch_name}.`); else if (error.sqlMessage.includes('branch_code')) return res.redirect(`/manage-programs?error=Duplicate Code: ${branch_code}.`); } console.error("Error adding program:", error); res.redirect('/manage-programs?error=Failed.'); }
});
app.post('/manage-programs/delete/:id', isAuthenticated, async (req, res) => {
     const programId = req.params.id; try { const [studentCheck] = await dbPool.query('SELECT COUNT(*) as count FROM users WHERE program_id = ?', [programId]); if (studentCheck[0].count > 0) return res.redirect(`/manage-programs?error=Cannot delete: ${studentCheck[0].count} student(s) assigned.`); const [result] = await dbPool.query('DELETE FROM programs WHERE program_id = ?', [programId]); if (result.affectedRows > 0) res.redirect('/manage-programs?success=Deleted!'); else res.redirect('/manage-programs?error=Not found.'); } catch (error) { console.error("Error deleting program:", error); if (error.code === 'ER_ROW_IS_REFERENCED_2') return res.redirect(`/manage-programs?error=Cannot delete: Referenced by users.`); res.redirect('/manage-programs?error=Failed.'); }
});

// --- Scheduled Tasks ---
async function autoLogoutCurrentDay() { const today = format(new Date(), 'yyyy-MM-dd'); const logoutTime = '19:00:00'; try { const [result] = await dbPool.query(`UPDATE attendance_log SET logout_time = ? WHERE log_date = ? AND logout_time IS NULL`, [logoutTime, today]); if (result.affectedRows > 0) console.log(`Auto-logged out ${result.affectedRows} for ${today}.`); } catch (error) { console.error('Auto-logout error:', error); } }
async function cleanupPreviousDays() { const today = format(new Date(), 'yyyy-MM-dd'); const logoutTime = '19:00:00'; try { const [result] = await dbPool.query(`UPDATE attendance_log SET logout_time = ? WHERE log_date < ? AND logout_time IS NULL`, [logoutTime, today]); if (result.affectedRows > 0) console.log(`Startup Cleanup: Logged out ${result.affectedRows} prev days.`); } catch (error) { console.error('Cleanup error:', error); } }
cron.schedule('5 19 * * *', () => { console.log('Running daily auto-logout...'); autoLogoutCurrentDay(); }, { scheduled: true, timezone: "Asia/Kolkata" });

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 Server running! Dashboard at http://localhost:${PORT}/dashboard`);
    cleanupPreviousDays(); // Run cleanup on startup
});

