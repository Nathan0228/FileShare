FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sft ./cmd/sft

FROM debian:bookworm-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/sft /usr/local/bin/sft
RUN install -d -m 0700 -o 10001 -g 10001 /srv/sft
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/sft"]
CMD ["serve"]
