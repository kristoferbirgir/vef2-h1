// src/routes/index.ts
import { Hono } from 'hono';
import authRouter from './auth.routes.js';
import itemRouter from './item.routes.js';
import ratingRouter from './rating.routes.js';
import { imageApi } from './images.routes.js'; // Adjust the import if your file name is different

export const mainRouter = new Hono();

mainRouter.get('/', (c) => c.json({ message: 'API' }));
mainRouter.route('/auth', authRouter);
mainRouter.route('/items', itemRouter);
mainRouter.route('/ratings', ratingRouter);
mainRouter.route('/cloudinary', imageApi); // Mount the image upload endpoint

export default mainRouter;
