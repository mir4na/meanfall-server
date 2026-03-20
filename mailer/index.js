const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const PORT = 3000;

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
    }
});

app.post('/send', async (req, res) => {
    const { to, otp } = req.body;

    if (!to || !otp) {
        return res.status(400).json({ error: "Missing 'to' or 'otp' in request body" });
    }

    if (!SMTP_USER || !SMTP_PASS) {
        console.warn(`[MAILER] SMTP credentials not set! Would have sent OTP ${otp} to ${to}`);
        return res.status(200).json({ success: true, note: "Credentials missing, printed to log only" });
    }

    try {
        await transporter.sendMail({
            from: `"MEANFALL Game" <${SMTP_USER}>`,
            to: to,
            subject: "Your MEANFALL Verification Code",
            text: `Your verification code is: ${otp}\n\nThis code will expire in 5 minutes.`,
            html: `<div style="font-family: sans-serif; text-align: center; padding: 20px; background-color: #1a1a2e; color: #ffffff; border-radius: 8px;">
                <h2 style="color: #a0a0ff;">MEANFALL</h2>
                <p>Your verification code is:</p>
                <h1 style="font-size: 36px; padding: 10px; background-color: #2a2a4e; display: inline-block; border-radius: 6px; letter-spacing: 6px; color: #4F46E5;">${otp}</h1>
                <p style="color: #8888aa; font-size: 12px;">This code will expire in 5 minutes.</p>
            </div>`
        });
        console.log(`[MAILER] Successfully sent OTP to ${to}`);
        res.status(200).json({ success: true });
    } catch (err) {
        console.error(`[MAILER] Failed to send email to ${to}:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[MAILER] Service listening on port ${PORT}`);
});
