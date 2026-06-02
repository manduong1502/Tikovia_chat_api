FROM node:20-alpine

# Cài đặt OpenSSL và libc6-compat cần cho Prisma hoạt động trên Alpine Linux
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev
RUN npx prisma generate

COPY . .

EXPOSE 5000

CMD ["npm", "run", "start"]
