// src/routes/index.ts
import { Hono } from 'hono';
import authRouter from './auth.routes.js';
import itemRouter from './item.routes.js';
import ratingRouter from './rating.routes.js';
import { imageApi } from './images.routes.js'; // Adjust the filename if needed

export const mainRouter = new Hono();

mainRouter.get('/', (c) =>
  c.json({
    message: 'API',
    routes: {
      auth: {
        register: 'POST /auth/register',
        login: 'POST /auth/login',
      },
      items: {
        getAll: 'GET /items',
        getById: 'GET /items/:id',
        create: 'POST /items (admin)',
        delete: 'DELETE /items/:id (admin)',
      },
      ratings: {
        upsert: 'POST /ratings',
      },
      images: {
        upload: 'POST /cloudinary (admin only)',
        all: 'GET /cloudinary/all'
      },
    },
  })
);

mainRouter.route('/auth', authRouter);
mainRouter.route('/items', itemRouter);
mainRouter.route('/ratings', ratingRouter);
mainRouter.route('/cloudinary', imageApi); // Mount your Cloudinary/image upload endpoints here

export default mainRouter;
