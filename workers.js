addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    const url = new URL(request.url);
    
    // Check if the path is '/random'
    if (url.pathname === '/random') {
        const collectionIds = url.searchParams.get('collections'); // Get collection IDs from query params
        const orientation = url.searchParams.get('orientation') || 'landscape'; // Get orientation from query params, default to 'landscape'
        const download = url.searchParams.get('dl') === 'true'; // Check if download tracking is requested
        const addPhotoOfTheDay = url.searchParams.get('addPhotoOfTheDay') === 'true'; // Check if the photo of the day should be added
        const randomPhotoUrl = 'https://api.unsplash.com/photos/random';
        
        // Check for mutual exclusivity
        if (addPhotoOfTheDay && collectionIds) {
            return new Response('Error: Cannot use both addPhotoOfTheDay and collections parameters together.', { status: 400 });
        }
        
        // Prepare the request to Unsplash API
        const fetchUrl = new URL(randomPhotoUrl);
        fetchUrl.searchParams.append('orientation', orientation); // Set orientation based on query param
        
        // Add the "photooftheday" collection if requested
        if (addPhotoOfTheDay) {
            fetchUrl.searchParams.append('collections', '1459961'); // Add the photo of the day collection
        } else if (collectionIds) {
            fetchUrl.searchParams.append('collections', collectionIds); // Add collections if provided
        }

        try {
            const response = await fetch(fetchUrl.toString(), {
                method: 'GET',
                headers: {
                    'Authorization': `Client-ID ${ACCESS_KEY}`, // Use your Unsplash Access Key
                    'Accept-Version': 'v1'
                }
            });

            // Check for other error statuses
            if (!response.ok) {
                console.error(`Error fetching from Unsplash: ${response.status} ${response.statusText}`);
                return new Response('Error fetching from Unsplash', { status: response.status });
            }

            const photoData = await response.json(); // Get the photo data

            // Check if download tracking is requested
            if (download) {
                const photoId = photoData.id; // Get the photo ID
                const downloadUrl = `https://api.unsplash.com/photos/${photoId}/download`; // Construct the download tracking URL
                
                // Trigger the download tracking request
                await fetch(downloadUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Client-ID ${ACCESS_KEY}`, // Use your Unsplash Access Key
                        'Accept-Version': 'v1'
                    }
                });
            }

            // Check for the 'url' parameter to redirect or dynamically resize
            const imageType = url.searchParams.get('url');
            if (download && imageType) {
                const validTypes = ['full', 'regular', 'small', 'thumb', 'raw'];
                if (validTypes.includes(imageType)) {
                    const imageUrl = photoData.urls[imageType]; // Get the URL for the specified type
                    // Return the direct link to the image along with artist info
                    return new Response(JSON.stringify({
                        imageUrl,
                        artistName: photoData.user.name,
                        artistProfileUrl: photoData.user.links.html
                    }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*', // Allow CORS
                        }
                    });
                } else {
                    return new Response('Invalid image type', { status: 400 }); // Return an error for invalid types
                }
            } else if (download && !imageType) {
                // If no url type is provided, allow dynamic resizing
                const rawImageUrl = photoData.urls.raw; // Get the raw image URL
                const width = url.searchParams.get('w') || '1920'; // Default width for background images
                const height = url.searchParams.get('h') || '1080'; // Default height for background images
                const crop = url.searchParams.get('crop'); // Get crop parameter
                const format = url.searchParams.get('fm'); // Get format parameter
                const quality = url.searchParams.get('q'); // Get quality parameter
                const fit = url.searchParams.get('fit'); // Get fit parameter
                const dpr = url.searchParams.get('dpr'); // Get device pixel ratio parameter

                // Construct the dynamic image URL
                const dynamicImageUrl = new URL(rawImageUrl);
                dynamicImageUrl.searchParams.append('w', width); // Set width for background
                dynamicImageUrl.searchParams.append('h', height); // Set height for background
                if (crop) dynamicImageUrl.searchParams.append('crop', crop);
                if (quality) dynamicImageUrl.searchParams.append('q', quality);
                if (fit) dynamicImageUrl.searchParams.append('fit', fit);
                if (dpr) dynamicImageUrl.searchParams.append('dpr', dpr);

                // Add auto=format if fm is not provided
                if (!format) {
                    dynamicImageUrl.searchParams.append('auto', 'format'); // Always add auto=format if fm is not provided
                }

                // Add fm if provided
                if (format) {
                    dynamicImageUrl.searchParams.append('fm', format); // Add the specified format
                }

                // Return the direct link to the dynamically constructed image URL
                return new Response(JSON.stringify({
                    imageUrl: dynamicImageUrl.toString(),
                    artistName: photoData.user.name,
                    artistProfileUrl: photoData.user.links.html
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*', // Allow CORS
                    }
                });
            } else {
                // Return the response from Unsplash API
                return new Response(JSON.stringify(photoData), {
                    status: response.status,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*', // Allow CORS
                    }
                });
            }
        } catch (error) {
            console.error(`Error in worker: ${error.message}`);
            return new Response('Internal Server Error', { status: 500 }); // Return a 500 error for unhandled exceptions
        }
    } else {
        // Return a 404 response for other paths
        return new Response('Not Found', { status: 404 });
    }
}