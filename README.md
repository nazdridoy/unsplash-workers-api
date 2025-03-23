# Unsplash Workers API

## Description
The Unsplash Workers API is a serverless API built with Cloudflare Workers that allows you to efficiently fetch and serve images from Unsplash.

## Features
- Fetch random images from Unsplash
- Search for images based on keywords
- Lightweight and fast response times
- Built with Cloudflare Workers for serverless deployment

## Architecture

```mermaid
flowchart TD
A[Client Request] --> B[Cloudflare Worker]
B --> C{Request Type?}
C -->|/random| D[handleRandomRequest]
C -->|/cache-status| E[handleCacheStatusRequest]
C -->|other| F[404 Not Found]
D --> G{Check Cache}
G -->|Main Cache Has Images| H[Serve from Main Cache]
G -->|Main Empty, Buffer Has Images| I[Copy Buffer to Main]
I --> H
G -->|Both Caches Empty| J[Fetch from Unsplash API]
J --> K[Return Image]
H --> K
subgraph "Async Background Processes"
L[Refill Buffer Cache]
M[Copy Buffer to Main]
N[Track Downloads]
end
H -.-> N
J -.-> N
H -.-> L
I -.-> L
```
## Caching System

```mermaid
flowchart LR
A[Request with Parameters] --> B[Generate Cache Key]
B --> C{Cache Status?}
C -->|Pattern 1: Main Cache Has Images| D[Serve from Main Cache]
C -->|Pattern 2: Main Empty, Buffer Has Images| E[Copy Buffer to Main]
E --> D
C -->|Pattern 3: Cold Start/Cache Miss| F[Fetch from Unsplash API]
D --> G[Return Image]
F --> G
subgraph "Background Operations"
H[Refill Buffer Cache]
I[Copy Buffer to Main]
end
D -.-> H
E -.-> H
F -.-> H
H -.-> I
```


## Deploying the Worker

To deploy the Unsplash Workers API, click the button below:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nazdridoy/unsplash-workers-api)

### API Endpoints

- **GET /random**: Fetch a random image from Unsplash.
  - **Query Parameters:**
    - `collections`: (optional) Comma-separated list of collection IDs to filter the images.
    - `orientation`: (optional) The orientation of the image. Default is `landscape`.
    - `dl`: (optional) Set to `true` to track downloads.
    - `addPhotoOfTheDay`: (optional) Set to `true` to include the photo of the day.
    - `url`: (optional) Specify the image type to return (e.g., `full`, `regular`, `small`, `thumb`, `raw`).
    - `w`: (optional) Width for dynamic resizing.
    - `h`: (optional) Height for dynamic resizing.
    - `crop`: (optional) Crop parameter for the image.
    - `fm`: (optional) Format of the image.
    - `q`: (optional) Quality of the image.
    - `fit`: (optional) Fit parameter for the image.
    - `dpr`: (optional) Device pixel ratio.

- **GET /cache-status**: View the current status of the caching system.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Unsplash](https://unsplash.com) for providing beautiful images.
- [Cloudflare Workers](https://workers.cloudflare.com) for enabling serverless functions.
