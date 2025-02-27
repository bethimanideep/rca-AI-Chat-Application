import crypto from 'crypto';

const SALT_LENGTH = 16; // Length of salt
const ITERATIONS = 100000; // Number of iterations (higher = more secure)
const KEY_LENGTH = 64; // Length of derived key
const DIGEST = 'sha512'; // Hashing algorithm

// Function to hash a password
export const hashPassword = (password: crypto.BinaryLike) => {
  return new Promise((resolve, reject) => {
    // Generate a random salt
    const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    
    // Hash the password using PBKDF2
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`); // Store salt and hash together
    });
  });
};

// Function to verify password
export const verifyPassword = (password: crypto.BinaryLike, storedHash: any) => {
  return new Promise((resolve, reject) => {
    const [salt, originalHash] = storedHash.split(':'); // Extract salt and hash
    
    // Hash the entered password with the same salt
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST, (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString('hex') === originalHash); // Compare hashes
    });
  });
};

