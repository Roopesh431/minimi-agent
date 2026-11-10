
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    status: "success",
    message: "Minimi Agent API is running",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Minimi API running at http://localhost:${PORT}`);
});
