import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import bcrypt from 'bcrypt'
import { cloudinary } from './cloudinary.js'
import { requireAuth, requireAdmin } from './middleware/auth.middleware.js'
import prisma from './utils/prisma.js'
import { signToken } from './utils/jwt.js'
import { sanitizeInput, isRateLimited } from './utils/security.js'

const app = new Hono()

app.use('*', cors({
  origin: ['https://krabs.netlify.app'],
  allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

app.use('*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for') || 'unknown'
  if (isRateLimited(ip)) {
    return c.json({ error: 'Too many requests' }, 429)
  }
  await next()
  c.header('Content-Security-Policy', "default-src 'self'")
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'geolocation=(), camera=()')
})

app.post('/auth/register', async (c) => {
  const { username, password } = await c.req.json()
  const cleanUsername = sanitizeInput(username)

  const existingUser = await prisma.user.findUnique({ where: { username: cleanUsername } })
  if (existingUser) {
    return c.json({ error: 'Username already taken' }, 400)
  }

  if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password)) {
    return c.json({
      error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character'
    }, 400)
  }

  const hashedPassword = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: {
      username: cleanUsername,
      password: hashedPassword,
      role: 'PLAYER'
    }
  })

  return c.json({
    message: 'User registered successfully',
    userId: user.id
  })
})

app.post('/auth/login', async (c) => {
  const { username, password } = await c.req.json()
  const user = await prisma.user.findUnique({ where: { username } })

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = signToken({ userId: user.id, role: user.role })

  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  })

  await prisma.log.create({
    data: {
      userId: user.id,
      action: 'LOGIN',
      details: 'User logged in successfully'
    }
  })

  return c.json({ token, userId: user.id, role: user.role })
})

app.post('/admin/upload', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.formData()
  const file = body.get('file') as File
  const prompt = body.get('prompt') as string

  if (!file) return c.json({ error: 'No file uploaded' }, 400)
  if (!prompt) return c.json({ error: 'Prompt is required' }, 400)

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const base64Image = buffer.toString('base64')
  const dataURI = `data:${file.type};base64,${base64Image}`

  try {
    const uploadResult = await cloudinary.uploader.upload(dataURI)
    const image = await prisma.image.create({
      data: {
        url: uploadResult.secure_url,
        prompt,
        uploadedById: String(c.user!.id)
      }
    })

    await prisma.log.create({
      data: {
        userId: String(c.user!.id),
        action: 'UPLOAD_IMAGE',
        details: `Image uploaded: ${image.id}`
      }
    })

    return c.json({ message: 'Image uploaded', image })
  } catch (error: any) {
    return c.json({ error: error.message || 'Upload failed' }, 500)
  }
})

app.get('/images/random', requireAuth, async (c) => {
  const images = await prisma.image.findMany({
    where: {
      ratings: {
        none: {
          userId: String(c.user!.id)
        }
      }
    },
    take: 1,
    orderBy: {
      createdAt: 'desc'
    }
  })

  if (images.length === 0) {
    return c.json({ message: 'No unrated images found' }, 404)
  }

  return c.json(images[0])
})

app.post('/images/rate/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const { score } = await c.req.json()

  if (![1, -1].includes(score)) {
    return c.json({ error: 'Invalid rating value, must be 1 or -1' }, 400)
  }

  const image = await prisma.image.findUnique({ where: { id } })
  if (!image) {
    return c.json({ error: 'Image not found' }, 404)
  }

  try {
    const rating = await prisma.rating.upsert({
      where: {
        userId_imageId: {
          userId: String(c.user!.id),
          imageId: id
        }
      },
      update: { score },
      create: {
        userId: String(c.user!.id),
        imageId: id,
        score
      }
    })

    await prisma.log.create({
      data: {
        userId: String(c.user!.id),
        action: 'RATE_IMAGE',
        details: `Rated image ${id} with score ${score}`
      }
    })

    return c.json({ message: 'Rated successfully', rating })
  } catch (error: any) {
    return c.json({ error: error.message || 'Rating failed' }, 500)
  }
})

app.get('/images/median', requireAuth, async (c) => {
  const ratings = await prisma.rating.findMany()
  if (ratings.length === 0) {
    return c.json({ median: 0 })
  }

  const scores = ratings
    .map((r: { score: number }) => r.score)
    .sort((a: number, b: number) => a - b)

  const median =
    scores.length % 2 === 0
      ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
      : scores[Math.floor(scores.length / 2)]

  return c.json({ median })
})

/* NEW ENDPOINT: Get ratings breakdown (likes, dislikes, percentage) for a specific image */
app.get('/images/:id/ratings', requireAuth, async (c) => {
  const id = c.req.param('id')

  // Verify the image exists.
  const image = await prisma.image.findUnique({ where: { id } })
  if (!image) {
    return c.json({ error: 'Image not found' }, 404)
  }

  // Count likes (score === 1) and dislikes (score === -1) for the specified image.
  const likeCount = await prisma.rating.count({
    where: { imageId: id, score: 1 }
  })
  const dislikeCount = await prisma.rating.count({
    where: { imageId: id, score: -1 }
  })

  const totalVotes = likeCount + dislikeCount
  const likePercentage = totalVotes === 0 ? 0 : (likeCount / totalVotes) * 100

  return c.json({
    likeCount,
    dislikeCount,
    likePercentage
  })
})

const port = Number(process.env.PORT || 3000)
process.env.PORT = port.toString()

serve(app, (info) => {
  console.log(`Server running on http://${info.address}:${info.port}`)
})

app.get('/images/rated', requireAuth, async (c) => {
  const userId = String(c.user!.id)
  
  // Get all ratings made by the current user, including the image details.
  const userRatings = await prisma.rating.findMany({
    where: { userId },
    include: { image: true },
  })

  // For each rated image, compute the aggregate rating data.
  const ratedImages = await Promise.all(
    userRatings.map(async (r) => {
      const imageId = r.image.id

      // Count the total likes for this image.
      const likeCount = await prisma.rating.count({
        where: {
          imageId,
          score: 1
        }
      })

      // Count the total dislikes for this image.
      const dislikeCount = await prisma.rating.count({
        where: {
          imageId,
          score: -1
        }
      })

      const totalVotes = likeCount + dislikeCount
      const likePercentage = totalVotes === 0 ? 0 : (likeCount / totalVotes) * 100

      return {
        id: imageId,
        url: r.image.url,
        prompt: r.image.prompt,
        currentRating: r.score,
        likeCount,
        dislikeCount,
        likePercentage
      }
    })
  )

  return c.json(ratedImages)
})



export default app
