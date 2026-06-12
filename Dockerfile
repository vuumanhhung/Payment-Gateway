FROM node:21.7-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml /app/

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
COPY package.json pnpm-lock.yaml /app/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . /app
RUN pnpm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
RUN npx playwright install --with-deps chromium
COPY --from=build /app/dist /app/dist
COPY --from=build /app/public /app/public
COPY --from=build /app/admin-ui /app/admin-ui
CMD [ "node", "./dist/src/main.js" ]

# docker build -t registry.gitlab.com/nhayhoc/payment-service:acb-test . && docker push registry.gitlab.com/nhayhoc/payment-service:acb-test
