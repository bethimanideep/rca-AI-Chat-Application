import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { ChatOpenAI } from "@langchain/openai";
import multer from "multer";
import pdfParse from "pdf-parse";
import { TokenTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import session from "express-session";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import { RetrievalQAChain } from "langchain/chains";
import { createClient } from "redis";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { WeaviateStore } from "@langchain/weaviate";
import cors from "cors";
import { Server } from "socket.io";
import http from "http";
import weaviate from "weaviate-ts-client";
import router from "./routes/auth";
import passport from "passport";
import cookieParser from "cookie-parser";

const userRetrievers: any = {};

// Initialize OpenAI embeddings model
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-ada-002",
});
// The Weaviate SDK has an issue with types
const weaviateClient = weaviate.client({
  scheme: "http",
  host: "localhost:8080",
});

const client = createClient({
  username: process.env.NAME,
  password: process.env.PASSWORD,
  socket: {
    host: process.env.HOST,
    port: 10431
  }
});

client.on("error", (err) => console.log("Redis Client Error", err));

const app = express();
app.use(
  cors({
    origin: process.env.CORS, // Explicitly allow frontend URL
    credentials: true, // Allow cookies and authentication headers
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: `${process.env.JWT_SECRET}`,
    resave: false,
    saveUninitialized: true,
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use("/auth", router);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS,
  },
});


const llm = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-3.5-turbo",
});

// Multer setup for handling file uploads in memory
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Function to process PDFs: extract text and chunk it
async function processPdf(fileBuffer: Buffer) {
  const data = await pdfParse(fileBuffer);
  const text = data.text;

  const splitter = new TokenTextSplitter({
    encodingName: "gpt2",
    chunkSize: 7500,
    chunkOverlap: 0,
  });

  const chunks = await splitter.createDocuments([text]);
  return chunks.map((chunk) => chunk.pageContent);
}

// Endpoint for uploading PDFs and storing embeddings in Pinecone

app.post("/upload", upload.array("files"), async (req: any, res: any) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: "No files uploaded." });
  }

  try {
    const batcher = weaviateClient.batch.objectsBatcher();

    for (let file of req.files as Express.Multer.File[]) {
      const chunks = await processPdf(file.buffer);
      console.log({ FileName: file.originalname, Chunks: chunks.length });

      // 🔹 Embed all chunks in one API call
      const embeddingsArray = await embeddings.embedDocuments(chunks);

      for (let i = 0; i < chunks.length; i++) {
        batcher.withObject({
          class: "Cwd", // ✅ Use the correct class name from your schema
          id: uuidv4(),
          properties: {
            file_name: file.originalname,
            timestamp: new Date().toISOString(),
            chunk_index: i,
            text: chunks[i], // ✅ Storing text correctly
          },
          vector: embeddingsArray[i], // ✅ Storing embeddings
        });
      }
    }

    // 🔹 Send batch request to Weaviate (if batcher has objects)
    if (batcher.objects.length > 0) {
      await batcher.do();
    }

    res.json({
      message: "PDFs processed and embeddings stored successfully in Weaviate",
    });
  } catch (error) {
    console.error("Error processing files:", error);
    res.status(500).json({ message: "Error processing files" });
  }
});

// Endpoint to delete all data in the pineconeIndex
app.delete("/delete", async (req, res) => {
  const className = "Cwd"; // Replace with your actual class name

  try {
    // Step 1: Delete the entire class (index) including its schema and data
    await weaviateClient.schema.classDeleter().withClassName(className).do();
    // Send success response
    res.status(200).json({
      message: `Class "${className}" and all its data have been deleted.`,
    });
  } catch (error) {
    console.error("Error deleting class:", error);

    // Send error response
    res
      .status(500)
      .json({ error: "An error occurred while deleting the class" });
  }
});

// 🚀 Search Endpoint
app.post("/search", async (req: any, res: any) => {
  try {
    const { query } = req.body; // Get user query

    if (!query) {
      return res.status(400).json({ message: "Query is required" });
    }

    const vectorStore = await WeaviateStore.fromExistingIndex(embeddings, {
      client: weaviateClient, // Weaviate client instance
      indexName: "Cwd", // Replace with your Weaviate class name
      metadataKeys: ["file_name"], // Include metadata fields you want to retrieve
      textKey: "text", // The property in Weaviate that contains the text
    });

    const retriever = vectorStore.asRetriever({
      k: 2, // Set the number of documents to return
    });

    // Create RetrievalQAChain
    const chain = RetrievalQAChain.fromLLM(llm, retriever, {
      returnSourceDocuments: true,
    });

    // Ask the question and get a response
    const response = await chain.call({
      query: query,
    });
    res.send(response.text);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ message: "Error searching Pinecone" });
  }
});

app.post("/searchbyfile", async (req: any, res: any) => {
  try {
    const { query, file_name } = req.body;

    if (!query || !file_name) {
      return res
        .status(400)
        .json({ message: "Both query and file_name are required" });
    }

    if (!userRetrievers[file_name]) {
      console.log("No Data Exists");

      // Query Weaviate with metadata filter
      const response = await weaviateClient.graphql
        .get()
        .withClassName("Cwd") // Replace with your actual Weaviate class name
        .withFields("text file_name _additional { vector }")
        .withWhere({
          path: ["file_name"],
          operator: "Equal",
          valueText: file_name,
        })
        .withLimit(10000)
        .do();

      const queryResponse = response.data.Get?.Cwd || [];

      if (queryResponse.length === 0) {
        return res.status(500).json({
          message: "Files are processing, wait sometime and try again",
        });
      }

      // Initialize the vector store
      let vectorStore = new MemoryVectorStore(embeddings);

      // Store retrieved data into MemoryVectorStore
      await Promise.all(
        queryResponse.map(async (doc: any) => {
          if (doc._additional?.vector && doc.text) {
            await vectorStore.addVectors(
              [doc._additional.vector],
              [
                new Document({
                  pageContent: String(doc.text),
                  metadata: { file_name: doc.file_name },
                }),
              ]
            );
          }
        })
      );

      userRetrievers[file_name] = vectorStore;
    }

    // Create a chain
    const chain = RetrievalQAChain.fromLLM(
      llm,
      userRetrievers[file_name].asRetriever({ k: 2 }),
      { returnSourceDocuments: true }
    );

    // Query the chain
    const responseData = await chain.call({ query });

    res.send(responseData.text);
  } catch (error) {
    console.error("Search error:", error);
    res
      .status(500)
      .json({ message: "Error searching Weaviate for the specific file" });
  }
});

app.get("/createIndex", async (req: any, res: any) => {
  try {
    const existingClasses = await weaviateClient.schema.getter().do();
    if (existingClasses.classes?.length == 0) {
      await weaviateClient.schema
        .classCreator()
        .withClass({
          class: "cwd",
          description: "Stores extracted text chunks from PDFs with embeddings", // ✅ Metadata for reference
          vectorizer: "none", // ✅ Since we use precomputed embeddings
          vectorIndexType: "hnsw",
          properties: [
            { name: "file_name", dataType: ["string"] },
            { name: "timestamp", dataType: ["date"] },
            { name: "chunk_index", dataType: ["int"] },
            { name: "text", dataType: ["text"] },
          ],
        })
        .do();
    } else {
      console.log("⚡ Weaviate schema already exists.");
    }
    res.send(existingClasses.classes);
  } catch (error) {
    console.error("Search error:", error);
    res
      .status(500)
      .json({ message: "Error searching Pinecone for the specific file" });
  }
});

app.get("/getAllData", async (req: any, res: any) => {
  try {
    const result = await weaviateClient.graphql
      .get()
      .withClassName("Cwd") // Replace with your actual class name
      .withFields(
        `
    file_name 
    timestamp 
    chunk_index 
    text 
    _additional { vector }
  `
      ) // Requesting vectors explicitly
      .do();
    res.send(result);
  } catch (error) {
    console.error("Error retrieving data:", error);
  }
});

// Endpoint to handle multiple file uploads
app.post(
  "/myuserupload",
  upload.array("files", 10),
  async (req: any, res: any) => {
    try {
      const { socketId } = req.query; // Get socketId from query params
      const files = req.files;

      if (!socketId) {
        return res.status(400).json({ message: "Socket ID is required." });
      }

      if (!files || files.length === 0) {
        return res.status(400).json({ message: "No files uploaded." });
      }
      io.emit("progressbar", 50);

      // Initialize the user's vector store object if it doesn't exist
      if (!userRetrievers[socketId]) {
        userRetrievers[socketId] = {};
      }
      const fileList: { filename: string }[] = []; 
      for (const file of files) {
        if (file.mimetype !== "application/pdf") {
          console.log(`Skipping non-PDF file: ${file.originalname}`);
          continue;
        }
        console.log(file.originalname);

        // Process the PDF and split into chunks
        const chunks = await processPdf(file.buffer);
        console.log({ FileName: file.originalname, Chunks: chunks.length });

        io.emit("progressbar", 75);
        // Embed all chunks in one API call
        const embeddingsArray = await embeddings.embedDocuments(chunks);

        // Create documents with metadata
        const documents = chunks.map((chunk, index) => ({
          pageContent: chunk,
          metadata: { file_name: file.originalname, chunk_index: index },
        }));

        // Initialize or update the vector store for the file
        if (!userRetrievers[socketId][file.originalname]) {
          userRetrievers[socketId][file.originalname] = new MemoryVectorStore(
            embeddings
          );
        }

        // Add documents to the vector store
        await userRetrievers[socketId][file.originalname].addVectors(
          embeddingsArray,
          documents
        );
        fileList.push({ filename: file.originalname });
      }
      io.emit("progressbar", 100);

      res
        .status(200)
        .json({ message: "Files uploaded and processed successfully.", fileList });
    } catch (error) {
      console.error("Error processing files:", error);
      res.status(500).json({ message: "Error processing files." });
    }
  }
);

app.post("/chat", async (req: any, res: any) => {
  try {
    const { query, file_name, socketId } = req.body;

    console.log("Received request:", { query, file_name, socketId });

    // Validate request body
    if (!query || !file_name || !socketId) {
      return res
        .status(400)
        .json({ error: "Query, file_name, and socketId are required." });
    }

    // Validate if user retriever exists
    if (!userRetrievers[socketId]) {
      console.log(`No retriever found for socketId: ${socketId}`);
      return res.status(400).json({ error: "Upload files first." });
    }

    // Validate if specific file exists when file_name is not "all"
    if (file_name !== "all" && !userRetrievers[socketId][file_name]) {
      console.log(
        `File not found for socketId: ${socketId}, file: ${file_name}`
      );
      return res.status(400).json({ error: "File not found." });
    }

    // Define retriever based on file_name
    let retriever;
    if (file_name === "all") {
      retriever = {
        async getRelevantDocuments(query: any) {
          console.log("Querying all retrievers...");
          const results = await Promise.all(
            Object.values(userRetrievers[socketId]).map((store: any) =>
              store.asRetriever({ k: 1 }).getRelevantDocuments(query)
            )
          );
          return results.flat();
        },
      };
    } else {
      retriever = userRetrievers[socketId][file_name].asRetriever({ k: 1 });
    }

    console.log("Retriever ready, running query...");
    const chain = RetrievalQAChain.fromLLM(llm, retriever);
    const response = await chain.call({ query });

    console.log("Response from chain:", response);
    res.status(200).json({
      answer: response.text || "No answer found",
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ message: "Server error." });
  }
});

app.get("/", (req, res) => {
  console.log(req.cookies);

  res.send(req.cookies);
});

// Start server
server.listen(process.env.SERVERPORT ?? 4000, async () => {
  try {
    await mongoose.connect(`${process.env.MONGO_URI}`);
    console.log("Connected to MongoDB");
    await client.connect();
    console.log("connected to redis");
    console.log(
      `Server is running on http://localhost:${process.env.PORT ?? 4000}`
    );
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
});

// Properly handle process exit
process.on("SIGINT", async () => {
  console.log("Received SIGINT. Cleaning up...");
  await mongoose.disconnect(); // Close MongoDB connection
  await client.disconnect();
  console.log("Database connection closed");
  process.exit(0);
});
