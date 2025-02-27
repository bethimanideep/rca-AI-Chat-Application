import tls from "tls";
import { Buffer } from "buffer";
import crypto from "crypto";

export const sendOTP = async (user: any, email: string) => {
  const otp = crypto.randomInt(100000, 999999).toString();
  const otpExpiresAt = new Date(Date.now() + 10 * 60000); // OTP valid for 10 minutes

  user.otp = otp;
  user.otpExpiresAt = otpExpiresAt;
  await user.save();

  await sendEmail(email, otp); // Send OTP via email
};

// Manual login route
function sendEmail(recipientEmail: string, otp: string) {
  return new Promise((resolve, reject) => {
    const EMAIL = process.env.EMAIL;
    const PASSWORD = process.env.PASSWORD;
    const client = tls.connect(
      {
        host: "smtp.gmail.com", // This should be in the options object
        port: 465, // Port should be specified here
      },
      () => {
        console.log("TLS connection established");
        console.log(EMAIL, PASSWORD);
      }
    );
    client.write(
      "EHLO localhost\r\n" +
        `AUTH PLAIN ${Buffer.from(`\0${EMAIL}\0${PASSWORD}`).toString(
          "base64"
        )}\r\n`
    );

    client.on("data", (data) => {
      const response = data.toString();

      if (response.includes("235")) {
        // Authentication successful, send the email
        client.write(
          `MAIL FROM:<${EMAIL}>\r\nRCPT TO:<${recipientEmail}>\r\nDATA\r\n`
        );
        client.write(
          `From: ${EMAIL}\r\n` +
            `To: ${recipientEmail}\r\n` +
            `Subject: Your OTP Code\r\n` +
            `\r\n` + // Blank line to separate headers from body
            `Your OTP code is: ${otp}\r\n` +
            `.\r\n` // End of data
        );
      } else if (response.includes("250 2.0.0 OK")) {
        // Email sent successfully
        client.end();
        console.log("Email sent successfully");
        resolve("Email sent successfully");
      }
    });

    client.on("error", (err) => {
      reject(err);
    });

    client.on("end", () => {
      console.log("SMTP connection closed");

      resolve("SMTP connection closed");
    });
  });
}
