addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request, event));
});

// Main request handler
async function handleRequest(request, event) {
    const url = new URL(request.url);
    
    // API endpoints
    if (url.pathname === '/random') {
        return handleRandomRequest(url, event);
    } else if (url.pathname === '/cache-status') {
        return handleCacheStatusRequest();
    } else if (url.pathname === '/metrics') {
        return handleMetricsRequest();
    } else {
        return new Response('Not Found', { status: 404 });
    }
}

// Handle random image requests
async function handleRandomRequest(url, event) {
    try {
        // Parse and validate parameters
        const params = {
            orientation: validateOrientation(url.searchParams.get('orientation')),
            collectionIds: sanitizeCollectionIds(url.searchParams.get('collections')),
            addPhotoOfTheDay: url.searchParams.get('addPhotoOfTheDay') === 'true',
            download: url.searchParams.get('dl') === 'true',
            imageType: url.searchParams.get('url'),
            width: sanitizeNumber(url.searchParams.get('w')) || '1920', // Default width 
            height: sanitizeNumber(url.searchParams.get('h')) || '1080', // Default height
            noCache: url.searchParams.get('nocache') === 'true',
            crop: url.searchParams.get('crop'),
            format: url.searchParams.get('fm'),
            quality: sanitizeNumber(url.searchParams.get('q')),
            fit: url.searchParams.get('fit'),
            dpr: sanitizeNumber(url.searchParams.get('dpr'))
        };
        
        // Check for mutual exclusivity
        if (params.addPhotoOfTheDay && params.collectionIds) {
            return new Response('Error: Cannot use both addPhotoOfTheDay and collections parameters together.', { status: 400 });
        }
        
        // Validate image type if provided
        if (params.imageType && !['full', 'regular', 'small', 'thumb', 'raw'].includes(params.imageType)) {
            return new Response('Invalid image type. Supported types: full, regular, small, thumb, raw', { status: 400 });
        }
        
        // Get or initialize metadata
        let metadata = await getOrInitializeMetadata();
        
        // Track request in metrics
        updateMetrics('totalRequests');
        
        // OPERATION PATTERN 1: Main cache has images - use it directly
        if (metadata.mainCache.count > 0 && !params.noCache) {
            const cacheResult = await getImageFromCache(metadata, params, 'main');
            
            if (cacheResult.imageData) {
                // Track download in background if needed
                if (params.download) {
                    event.waitUntil(trackDownload(cacheResult.imageData.id));
                    updateMetrics('downloads');
                }
                
                updateMetrics('cacheHits');
                updateMetrics('mainCacheHits');
                
                // If metadata changed, update it
                if (cacheResult.metadataChanged) {
                    await updateMetadata(metadata);
                }
                
                // Check if main cache is now empty after this request
                if (metadata.mainCache.count === 0 && metadata.bufferCache.count > 0) {
                    // Refill main from buffer in background 
                    event.waitUntil(refillCacheSystem(metadata));
                }
                
                return formatResponse(cacheResult.imageData, params);
            }
        }
        
        // OPERATION PATTERN 2: Main cache empty but buffer has images
        if (metadata.mainCache.count === 0 && metadata.bufferCache.count > 0 && !params.noCache) {
            console.log("Main cache empty - copying buffer to main for immediate use");
            
            // Copy buffer to main immediately to serve this request
            await copyBufferToMain(metadata);
            
            // Now try to get image from the newly filled main cache
            const cacheResult = await getImageFromCache(metadata, params, 'main');
            
            if (cacheResult.imageData) {
                // Track download in background if needed
                if (params.download) {
                    event.waitUntil(trackDownload(cacheResult.imageData.id));
                    updateMetrics('downloads');
                }
                
                updateMetrics('cacheHits');
                updateMetrics('mainCacheHits');
                
                // If metadata changed, update it
                if (cacheResult.metadataChanged) {
                    await updateMetadata(metadata);
                }
                
                // Start buffer refill in background
                event.waitUntil(refillBufferCache(metadata));
                
                return formatResponse(cacheResult.imageData, params);
            }
        }
        
        // OPERATION PATTERN 3: COLD START or CACHE MISS - both caches empty
        console.log("Cache miss or cold start - using direct API");
        updateMetrics('cacheMisses');
        
        if (metadata.mainCache.count === 0 && metadata.bufferCache.count === 0) {
            updateMetrics('coldStarts');
        }
        
        // Fetch directly from Unsplash API
        updateMetrics('apiCalls');
        const imageData = await fetchImageFromUnsplash(params);
        
        // Track download if needed
        if (params.download) {
            event.waitUntil(trackDownload(imageData.id));
            updateMetrics('downloads');
        }
        
        // If both caches are empty, trigger refill in background
        if (metadata.mainCache.count === 0 && metadata.bufferCache.count === 0) {
            event.waitUntil(refillBufferCache(metadata).then(async (updatedMeta) => {
                // After buffer is refilled, copy buffer to main
                await copyBufferToMain(updatedMeta);
                // Refill buffer again
                await refillBufferCache(updatedMeta);
            }));
        }
        
        return formatResponse(imageData, params);
    } catch (error) {
        console.error(`Error in worker: ${error.message}`);
        updateMetrics('errors');
        
        // Determine appropriate status code
        let status = 500;
        if (error.message.includes('Circuit breaker')) status = 503;
        if (error.message.includes('Rate limit')) status = 429;
        
        return new Response(`Error: ${error.message}`, { status });
    }
}

// Helper: Format the response based on parameters
function formatResponse(imageData, params) {
    // Basic checks
    if (!imageData || !imageData.urls) {
        throw new Error('Invalid image data received');
    }
    
    // Handle various response formats
    if (params.download && params.imageType) {
        // Return specific image type URL
        const imageUrl = imageData.urls[params.imageType];
        
                    return new Response(JSON.stringify({
                        imageUrl,
            artistName: imageData.user.name,
            artistProfileUrl: imageData.user.links.html,
            photoId: imageData.id,
            description: imageData.description || imageData.alt_description || "Unsplash Image"
                    }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=300' // 5-minute cache
            }
        });
    } else if (params.download && !params.imageType) {
        // Handle dynamic resizing
        const rawImageUrl = imageData.urls.raw;
                const dynamicImageUrl = new URL(rawImageUrl);
        
        // Add parameters for dynamic resizing
        if (params.width) dynamicImageUrl.searchParams.append('w', params.width);
        if (params.height) dynamicImageUrl.searchParams.append('h', params.height);
        if (params.crop) dynamicImageUrl.searchParams.append('crop', params.crop);
        if (params.quality) dynamicImageUrl.searchParams.append('q', params.quality);
        if (params.fit) dynamicImageUrl.searchParams.append('fit', params.fit);
        if (params.dpr) dynamicImageUrl.searchParams.append('dpr', params.dpr);
        
        // Add auto=format if format is not provided
        if (!params.format) {
            dynamicImageUrl.searchParams.append('auto', 'format');
        } else {
            dynamicImageUrl.searchParams.append('fm', params.format);
                }

                // Return the direct link to the dynamically constructed image URL
                return new Response(JSON.stringify({
                    imageUrl: dynamicImageUrl.toString(),
            artistName: imageData.user.name,
            artistProfileUrl: imageData.user.links.html,
            photoId: imageData.id,
            description: imageData.description || imageData.alt_description || "Unsplash Image"
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=300'
                    }
                });
            } else {
        // Return full photo data
        return new Response(JSON.stringify(imageData), {
            status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store' // Don't cache full responses
            }
        });
    }
}

// Cache Management System
// -----------------------------------------------------------

// Get or initialize cache metadata
async function getOrInitializeMetadata() {
    let metadata = await NAZKVHUBSTORE.get('STOREMETA', { type: 'json' });
    
    if (!metadata) {
        console.log("Initializing fresh metadata");
        
        metadata = {
            mainCache: {
                count: 0,          // Number of images in main cache
                currentPointer: 0  // Current position (0-29)
            },
            bufferCache: {
                count: 0,          // Number of images in buffer cache
                currentPointer: 0  // Current position (0-29)
            },
            isRefilling: false,
            lastRefillTime: 0,
            metrics: {
                totalRequests: 0,
                cacheHits: 0,
                cacheMisses: 0,
                mainCacheHits: 0,
                bufferCacheHits: 0,
                apiCalls: 0,
                downloads: 0,
                errors: 0,
                coldStarts: 0
            }
        };
        
        // Initialize empty caches
        await NAZKVHUBSTORE.put('MAINCACHE', JSON.stringify(Array(30).fill(null)));
        await NAZKVHUBSTORE.put('BUFFERCACHE', JSON.stringify(Array(30).fill(null)));
        await updateMetadata(metadata);
    }
    
    return metadata;
}

// Update metadata in KV store
async function updateMetadata(metadata) {
    return NAZKVHUBSTORE.put('STOREMETA', JSON.stringify(metadata));
}

// Get image from specific cache using pointer-based approach
async function getImageFromCache(metadata, params, cacheType = 'main') {
    const cache = cacheType === 'main' ? metadata.mainCache : metadata.bufferCache;
    const cacheKey = cacheType === 'main' ? 'MAINCACHE' : 'BUFFERCACHE';
    
    // No images in this cache
    if (cache.count === 0) {
        return { imageData: null, metadataChanged: false };
    }
    
    // Get the entire cache array with one operation
    const cacheArray = await NAZKVHUBSTORE.get(cacheKey, { type: 'json' });
    if (!cacheArray) {
        // Cache should exist but doesn't - recreate it
        await NAZKVHUBSTORE.put(cacheKey, JSON.stringify(Array(30).fill(null)));
        cache.count = 0;
        return { imageData: null, metadataChanged: true };
    }
    
    const { orientation, collectionIds, addPhotoOfTheDay } = params;
    let checkedCount = 0;
    let foundIndex = -1;
    
    // Search through available images using pointer
    while (checkedCount < cache.count) {
        // Move pointer to next position
        cache.currentPointer = (cache.currentPointer + 1) % 30;
        
        // Check if this slot has an image
        if (cacheArray[cache.currentPointer]) {
            checkedCount++;
            
            // Check if image matches criteria
            if (matchesCriteria(cacheArray[cache.currentPointer], orientation, collectionIds, addPhotoOfTheDay)) {
                foundIndex = cache.currentPointer;
                break;
            }
        }
    }
    
    // No matching image found
    if (foundIndex === -1) {
        return { imageData: null, metadataChanged: true };
    }
    
    // Found a matching image - get it and clear the slot
    const imageData = cacheArray[foundIndex];
    cacheArray[foundIndex] = null;
    cache.count--;
    
    // Update the cache with one operation
    await NAZKVHUBSTORE.put(cacheKey, JSON.stringify(cacheArray));
    
    return { imageData, metadataChanged: true };
}

// Copy entire buffer cache to main cache - SYNCHRONOUS OPERATION
async function copyBufferToMain(metadata) {
    console.log("Copying buffer to main cache");
    
    try {
        // Get both caches with minimal operations
        const bufferArray = await NAZKVHUBSTORE.get('BUFFERCACHE', { type: 'json' });
        
        if (!bufferArray) {
            throw new Error('Buffer cache not found');
        }
        
        // Copy buffer to main directly
        await NAZKVHUBSTORE.put('MAINCACHE', JSON.stringify(bufferArray));
        
        // Update metadata
        metadata.mainCache.count = metadata.bufferCache.count;
        metadata.mainCache.currentPointer = 0;  // Reset pointer for fresh access
        await updateMetadata(metadata);
        
        console.log(`Buffer copy complete. Main cache now has ${metadata.mainCache.count} images`);
        return metadata;
    } catch (error) {
        console.error(`Error copying buffer to main: ${error.message}`);
        throw error;
    }
}

// Refill buffer cache with new images - ASYNCHRONOUS OPERATION
async function refillBufferCache(metadata) {
    console.log("Refilling buffer cache");
    
    if (metadata.isRefilling) {
        console.log("Refill already in progress, skipping");
        return metadata;
    }
    
    try {
        // Mark refill in progress
        metadata.isRefilling = true;
        await updateMetadata(metadata);
        
        // Fetch images in bulk (30 at once)
        const fetchUrl = new URL('https://api.unsplash.com/photos/random');
        fetchUrl.searchParams.append('count', '30');
        
        // Make the API request
        const response = await fetch(fetchUrl.toString(), {
            headers: {
                'Authorization': `Client-ID ${ACCESS_KEY}`,
                'Accept-Version': 'v1'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Unsplash API error: ${response.status} ${response.statusText}`);
        }
        
        const fullImages = await response.json();
        updateMetrics('apiCalls');
        
        // Process and optimize the images to store only what's needed
        const optimizedImages = fullImages.map(img => ({
            id: img.id,
            urls: img.urls,
            user: {
                name: img.user.name,
                links: { html: img.user.links.html }
            },
            width: img.width,
            height: img.height,
            description: img.description || img.alt_description,
            current_user_collections: img.current_user_collections
        }));
        
        // Update buffer cache with one operation
        await NAZKVHUBSTORE.put('BUFFERCACHE', JSON.stringify(optimizedImages));
        
        // Update metadata
        metadata.bufferCache.count = 30;
        metadata.bufferCache.currentPointer = 0;
        metadata.isRefilling = false;
        metadata.lastRefillTime = Date.now();
        await updateMetadata(metadata);
        
        console.log("Buffer refill complete");
        return metadata;
    } catch (error) {
        // Reset refill flag on error
        metadata.isRefilling = false;
        await updateMetadata(metadata);
        console.error(`Refill error: ${error.message}`);
        throw error;
    }
}

// Helper function to trigger full cache system refresh - ASYNCHRONOUS OPERATION
async function refillCacheSystem(metadata) {
    try {
        console.log("Triggering full cache system refresh");
        
        // First copy buffer to main
        await copyBufferToMain(metadata);
        
        // Then refill buffer
        await refillBufferCache(metadata);
        
        return metadata;
    } catch (error) {
        console.error(`Cache system refresh error: ${error.message}`);
        throw error;
    }
}

// Check if image matches criteria
function matchesCriteria(imageData, orientation, collectionIds, addPhotoOfTheDay) {
    // Check orientation if specified
    if (orientation) {
        const imgOrientation = getImageOrientation(imageData);
        if (imgOrientation !== orientation) return false;
    }
    
    // Check collection if specified
    if (collectionIds) {
        // Convert string to array of collection IDs
        const collectionIdArray = collectionIds.split(',');
        
        // Check if image belongs to any of the specified collections
        const imageCollections = imageData.current_user_collections || [];
        const collectionMatch = imageCollections.some(collection => 
            collectionIdArray.includes(collection.id.toString())
        );
        
        if (!collectionMatch) return false;
    }
    
    // Check for photo of the day
    if (addPhotoOfTheDay) {
        const imageCollections = imageData.current_user_collections || [];
        const isPotd = imageCollections.some(collection => 
            collection.id.toString() === '1459961' // Photo of the day collection ID
        );
        
        if (!isPotd) return false;
    }
    
    return true; // Image matches all criteria
}

// API and External Services
// -----------------------------------------------------------

// Fetch image directly from Unsplash API
async function fetchImageFromUnsplash(params) {
    const { orientation, collectionIds, addPhotoOfTheDay } = params;
    
    const fetchUrl = new URL('https://api.unsplash.com/photos/random');
    if (orientation) fetchUrl.searchParams.append('orientation', orientation);
    
    if (addPhotoOfTheDay) {
        fetchUrl.searchParams.append('collections', '1459961'); // Photo of the day collection ID
    } else if (collectionIds) {
        fetchUrl.searchParams.append('collections', collectionIds);
    }
    
    // Make the API request
    const response = await fetch(fetchUrl.toString(), {
        headers: {
            'Authorization': `Client-ID ${ACCESS_KEY}`,
            'Accept-Version': 'v1'
        }
    });
    
    // Check for errors
    if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const fullImage = await response.json();
    
    // Return optimized image object to save space
    return {
        id: fullImage.id,
        urls: fullImage.urls,
        user: {
            name: fullImage.user.name,
            links: { html: fullImage.user.links.html }
        },
        width: fullImage.width,
        height: fullImage.height,
        description: fullImage.description || fullImage.alt_description,
        current_user_collections: fullImage.current_user_collections
    };
}

// Circuit breaker state
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    state: 'CLOSED', // CLOSED (normal), OPEN (failing), HALF-OPEN (testing)
    resetThreshold: 30000, // 30 seconds before trying again
    failureThreshold: 3 // Number of failures before opening circuit
};

// Track download with Unsplash
async function trackDownload(photoId) {
    try {
        const downloadUrl = `https://api.unsplash.com/photos/${photoId}/download`;
        await fetch(downloadUrl, {
            headers: {
                'Authorization': `Client-ID ${ACCESS_KEY}`,
                'Accept-Version': 'v1'
            }
        });
        return true;
        } catch (error) {
        console.error(`Download tracking error: ${error.message}`);
        return false;
    }
}

// Utility Functions
// -----------------------------------------------------------

// Determine image orientation based on dimensions
function getImageOrientation(imageData) {
    if (!imageData.width || !imageData.height) return null;
    
    const ratio = imageData.width / imageData.height;
    if (ratio > 1.2) return 'landscape';
    if (ratio < 0.8) return 'portrait';
    return 'squarish';
}

// Validate orientation parameter
function validateOrientation(orientation) {
    const validOrientations = ['landscape', 'portrait', 'squarish'];
    return validOrientations.includes(orientation) ? orientation : 'landscape'; // Default to landscape
}

// Sanitize collection IDs parameter
function sanitizeCollectionIds(collections) {
    if (!collections) return null;
    // Ensure only numbers and commas are in the collection IDs
    return collections.replace(/[^0-9,]/g, '');
}

// Sanitize numeric parameters
function sanitizeNumber(value) {
    if (!value) return null;
    const num = parseInt(value, 10);
    return isNaN(num) ? null : num.toString();
}

// Update metrics with batching to reduce KV operations
let metricsUpdateQueue = {};
let metricsUpdateTimer = null;

// Update metrics with batching
async function updateMetrics(metricName) {
    // Add to queue
    metricsUpdateQueue[metricName] = (metricsUpdateQueue[metricName] || 0) + 1;
    
    // If timer not set, set one to process queue
    if (!metricsUpdateTimer) {
        metricsUpdateTimer = setTimeout(async () => {
            try {
                const metadata = await getOrInitializeMetadata();
                
                // Apply all queued updates
                for (const [metric, count] of Object.entries(metricsUpdateQueue)) {
                    if (metadata.metrics && metadata.metrics[metric] !== undefined) {
                        metadata.metrics[metric] += count;
                    }
                }
                
                // Save updated metadata
                await updateMetadata(metadata);
                
                // Clear queue and timer
                metricsUpdateQueue = {};
                metricsUpdateTimer = null;
            } catch (error) {
                console.error(`Batch metrics update error: ${error.message}`);
                // Clear timer but keep queue for retry
                metricsUpdateTimer = null;
            }
        }, 2000); // Batch updates every 2 seconds
    }
}

// API Endpoints
// -----------------------------------------------------------

// Handle cache status request
async function handleCacheStatusRequest() {
    try {
        const metadata = await getOrInitializeMetadata();
        
        // Calculate cache fill percentages
        const mainFillPercent = Math.round((metadata.mainCache.count / 30) * 100);
        const bufferFillPercent = Math.round((metadata.bufferCache.count / 30) * 100);
        
        // Format response
        const status = {
            mainCache: {
                images: metadata.mainCache.count,
                fillPercent: mainFillPercent,
                currentPointer: metadata.mainCache.currentPointer
            },
            bufferCache: {
                images: metadata.bufferCache.count,
                fillPercent: bufferFillPercent,
                currentPointer: metadata.bufferCache.currentPointer
            },
            isRefilling: metadata.isRefilling,
            lastRefillTime: metadata.lastRefillTime,
            lastRefreshRelative: metadata.lastRefillTime ? `${Math.round((Date.now() - metadata.lastRefillTime) / 1000 / 60)} minutes ago` : 'never'
        };
        
        return new Response(JSON.stringify(status, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}

// Handle metrics request
async function handleMetricsRequest() {
    try {
        const metadata = await getOrInitializeMetadata();
        
        // Calculate some derived metrics
        const cacheHitRate = metadata.metrics.totalRequests > 0 
            ? Math.round((metadata.metrics.cacheHits / metadata.metrics.totalRequests) * 100)
            : 0;
        
        const metrics = {
            ...metadata.metrics,
            cacheHitRate: `${cacheHitRate}%`,
            averageApiCallsPerRequest: metadata.metrics.totalRequests > 0
                ? (metadata.metrics.apiCalls / metadata.metrics.totalRequests).toFixed(4)
                : 0
        };
        
        return new Response(JSON.stringify(metrics, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}