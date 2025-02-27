import mongoose from 'mongoose';

// Define Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, required: true },
  authenticationType: { type: String, required: true }, // New field for authentication type (e.g., 'google', 'github')
  verified: { type: Boolean, default: false }, 
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const manualLoginUserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String }, // Added password field
  otp: { type: String }, // Store OTP temporarily
  otpExpiresAt: { type: Date }, // OTP expiration time
  verified: { type: Boolean, default: false }, // Whether the user is verified
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});



// Export models
const User = mongoose.model('User', userSchema);
const ManualLoginUser = mongoose.model('ManualLoginUser', manualLoginUserSchema);

export { User, ManualLoginUser };
