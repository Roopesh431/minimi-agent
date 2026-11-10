
import express from "express";
import cors from "cors";
import conversationRoutes from "./routes/conversationRoutes";


const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "success",
    message: "Minimi Agent API is running",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/conversations", conversationRoutes);

app.listen(PORT, () => {
  console.log(`Minimi API running at http://localhost:${PORT}`);
});
