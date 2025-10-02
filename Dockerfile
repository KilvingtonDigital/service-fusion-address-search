# Apify base image with Playwright + Chrome
FROM apify/actor-node-playwright-chrome:20

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source code
COPY . ./

# Start the actor
CMD ["npm", "start"]