import { prisma } from '../config/database';
import { CreateUserParams } from '../types';
import { logger } from '../utils/logger';

export const getOrCreateUser = async (params: CreateUserParams) => {
  const { phoneNumber, name, email } = params;

  const existingUser = await prisma.user.findUnique({
    where: { phoneNumber },
  });

  if (existingUser) {
    if (name && name !== existingUser.name) {
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { name },
      });
    }
    return { ...existingUser, name: name || existingUser.name };
  }

  const newUser = await prisma.user.create({
    data: {
      phoneNumber,
      name,
      email,
    },
  });

  logger.info('User created', { userId: newUser.id, phoneNumber });

  return newUser;
};

export const getUserById = async (id: string) => {
  return prisma.user.findUnique({
    where: { id },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        include: { group: true },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });
};

export const getUserByPhoneNumber = async (phoneNumber: string) => {
  return prisma.user.findUnique({
    where: { phoneNumber },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        include: { group: true },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });
};

export const getUsers = async (page = 1, limit = 20) => {
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count(),
  ]);

  return {
    data: users,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};