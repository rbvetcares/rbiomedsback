require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 5001;

// Cloudinary Configuration
cloudinary.config({
    cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || "").trim(),
    api_key: (process.env.CLOUDINARY_API_KEY || "").trim(),
    api_secret: (process.env.CLOUDINARY_API_SECRET || "").trim()
});

console.log("Cloudinary Config Re-verified:", {
    cloud_name: cloudinary.config().cloud_name,
    api_key: cloudinary.config().api_key,
    secret_length: cloudinary.config().api_secret ? cloudinary.config().api_secret.length : 0,
    secret_preview: cloudinary.config().api_secret ? `${cloudinary.config().api_secret.substring(0, 3)}...${cloudinary.config().api_secret.slice(-3)}` : 'none'
});

// Use Memory Storage instead of CloudinaryStorage for more control
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schema
const ArticleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    image: {
        type: String,
        default: "https://images.unsplash.com/photo-1576091160550-217359f42f8c?q=80&w=2070&auto=format&fit=crop"
    },
    category: { type: String, default: "General" },
    sites: { type: [String], default: ["rbiomeds"] },
    date: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

// Transform _id to id for frontend compatibility
ArticleSchema.set('toJSON', {
    transform: (document, returnedObject) => {
        returnedObject.id = returnedObject._id.toString();
        // Always provide a formatted date string for the frontend
        if (returnedObject.date) {
            returnedObject.date = new Date(returnedObject.date).toLocaleDateString('en-US', {
                month: 'long',
                day: '2-digit',
                year: 'numeric'
            });
        }
        delete returnedObject._id;
        delete returnedObject.__v;
    }
});

const Article = mongoose.model('Article', ArticleSchema);

app.use(cors());
app.use(express.json());

// Image Upload Endpoint with Direct Cloudinary Upload
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Please upload a file' });
        }

        // Upload directly using buffer
        const fileBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: 'rbiomeds_articles',
        });

        console.log("Upload successful:", result.secure_url);
        res.json({ imageUrl: result.secure_url });
    } catch (err) {
        console.error("Cloudinary Error:", err);
        res.status(500).json({ error: `Upload error: ${err.message || 'Unknown error'}` });
    }
});

// Helper to parse date safely without timezone shifts
const parseDate = (dateStr) => {
    if (!dateStr) return new Date();

    // Check if it's already a Date object
    if (dateStr instanceof Date) return dateStr;

    // If it's a string like "February 13, 2026" (formatted by toJSON)
    // or "2026-02-13" (sent by frontend)
    try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            // If it's YYYY-MM-DD from the frontend input, we want to treat it as local date
            // to avoid timezone shifts when it's just a "day" value.
            if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                const [year, month, day] = dateStr.split('-').map(Number);
                return new Date(year, month - 1, day);
            }
            return d;
        }
    } catch (e) {
        console.error("Error parsing date:", e);
    }

    return new Date();
};

// Routes
app.get('/api/articles', async (req, res) => {
    try {
        const { site } = req.query;
        let query = {};
        if (site) {
            if (site === 'rbiomeds') {
                // Return articles where sites includes 'rbiomeds' OR the sites field doesn't exist (legacy)
                query = {
                    $or: [
                        { sites: 'rbiomeds' },
                        { sites: { $exists: false } }
                    ]
                };
            } else if (site === 'abc-international') {
                query = { sites: 'abc-international' };
            } else if (site === 'both') {
                // Return articles that are published to BOTH platforms
                query = { sites: { $all: ['rbiomeds', 'abc-international'] } };
            } else {
                query = { sites: site };
            }
        }
        // Primary sort by date (manual), secondary by createdAt (order of entry for same day)
        const articles = await Article.find(query).sort({ date: -1, createdAt: -1 });
        res.json(articles);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch articles" });
    }
});

app.post('/api/articles', async (req, res) => {
    try {
        const { title, description, image, category, sites, date } = req.body;

        const parsedDate = parseDate(date);
        console.log("Creating article:", {
            title,
            receivedDate: date,
            parsedDate: parsedDate.toISOString()
        });

        const newArticle = new Article({
            title,
            description,
            image: image || undefined,
            category: category || undefined,
            sites: sites || ["rbiomeds"],
            date: parsedDate
        });

        await newArticle.save();
        res.status(201).json(newArticle);
    } catch (error) {
        console.error("Failed to create article:", error);
        res.status(500).json({ error: "Failed to create article" });
    }
});

app.put('/api/articles/:id', async (req, res) => {
    try {
        const { title, description, image, category, sites, date } = req.body;

        const updatedDate = date ? parseDate(date) : undefined;
        console.log("Updating article:", { id: req.params.id, title, receivedDate: date, parsedDate: updatedDate?.toISOString() });

        const updateData = {
            title,
            description,
            image,
            category,
            sites: sites || ["rbiomeds"]
        };

        if (updatedDate) {
            updateData.date = updatedDate;
        }

        const updatedArticle = await Article.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true }
        );

        if (!updatedArticle) {
            return res.status(404).json({ error: "Article not found" });
        }

        res.json(updatedArticle);
    } catch (error) {
        res.status(500).json({ error: "Failed to update article" });
    }
});

app.delete('/api/articles/:id', async (req, res) => {
    try {
        const result = await Article.findByIdAndDelete(req.params.id);

        if (!result) {
            return res.status(404).json({ error: "Article not found" });
        }

        res.json({ message: "Article deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete article" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
