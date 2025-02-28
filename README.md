# Unsplash Workers API

## Description
Unsplash Workers API is a serverless API that allows you to interact with the Unsplash API using Cloudflare Workers. This project aims to provide a lightweight and efficient way to fetch and serve images from Unsplash, leveraging the power of serverless architecture.

## Features
- Fetch random images from Unsplash
- Search for images based on keywords
- Lightweight and fast response times
- Built with Cloudflare Workers for serverless deployment

## Deploying the Worker

To deploy the Unsplash Workers API, click the button below:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button.svg)](https://cloudflare.com/workers)

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

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Unsplash](https://unsplash.com) for providing beautiful images.
- [Cloudflare Workers](https://workers.cloudflare.com) for enabling serverless functions.
