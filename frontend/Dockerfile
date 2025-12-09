# ---------- Stage 1: Build Vite app ----------
FROM node:20-alpine AS build

# Set working directory
WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy all project files
COPY . .

# Build the application
RUN npm run build


# ---------- Stage 2: Serve using NGINX ----------
FROM nginx:1.27-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy your nginx.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy build output from Node stage
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Start NGINX
CMD ["nginx", "-g", "daemon off;"]
