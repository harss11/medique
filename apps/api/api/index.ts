import { createApp } from "../src/app.js";

// Vercel runs the Express app as a serverless function (no app.listen, no background jobs).
export default createApp();
