// Main request handler
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, ctx, env);
  }
};

async function handleRequest(request, ctx, env) {
    const url = new URL(request.url);
    
    // API endpoints
    if (url.pathname === '/random') {
        return handleRandomRequest(url, ctx, env);
    } else if (url.pathname === '/cache-status') {
        return handleCacheStatusRequest(env);
    } else {
        return new Response('Not Found', { status: 404 });
    }
}

// Handle random image requests
async function handleRandomRequest(url, ctx, env) {
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
        
        // Generate cache key for this parameter combination
        const cacheKey = generateCacheKey(params);
        
        // Get or initialize metadata for this cache key
        let metadata = await getOrInitializeMetadata(cacheKey, env);
        
        // OPERATION PATTERN 1: Main cache has images - use it directly
        if (metadata.mainCache.count > 0 && !params.noCache) {
            const cacheResult = await getImageFromCache(metadata, params, 'main', cacheKey, env);
            
            if (cacheResult.imageData) {
                // Track download in background if needed
                if (params.download) {
                    ctx.waitUntil(trackDownload(cacheResult.imageData.id, env));
                }
                
                // If metadata changed, update it
                if (cacheResult.metadataChanged) {
                    await updateMetadata(metadata, cacheKey, env);
                }
                
                // Check if main cache is now empty after this request
                if (metadata.mainCache.count === 0 && metadata.bufferCache.count > 0) {
                    // Refill main from buffer in background 
                    ctx.waitUntil(refillCacheSystem(metadata, cacheKey, params, env));
                }
                
                return formatResponse(cacheResult.imageData, params);
            }
        }
        
        // OPERATION PATTERN 2: Main cache empty but buffer has images
        if (metadata.mainCache.count === 0 && metadata.bufferCache.count > 0 && !params.noCache) {
            console.log(`Main cache empty for key ${cacheKey} - fetching directly from buffer`);
            
            // Get directly from buffer cache without copying to main first
            const cacheResult = await getImageFromCache(metadata, params, 'buffer', cacheKey, env);
            
            if (cacheResult.imageData) {
                // Create response first
                const response = formatResponse(cacheResult.imageData, params);
                
                // Do all maintenance work in the background
                ctx.waitUntil(async function() {
                    // Track download if needed
                    if (params.download) {
                        await trackDownload(cacheResult.imageData.id, env);
                    }
                    
                    // Update metadata if needed
                    if (cacheResult.metadataChanged) {
                        await updateMetadata(metadata, cacheKey, env);
                    }
                    
                    // Copy buffer to main and refill buffer in the background
                    await copyBufferToMain(metadata, cacheKey, env);
                    await refillBufferCache(metadata, cacheKey, params, env);
                }());
                
                // Return the response immediately, don't wait for background work
                return response;
            }
        }
        
        // OPERATION PATTERN 3: COLD START or CACHE MISS - both caches empty
        console.log(`Cache miss or cold start for key ${cacheKey} - using direct API`);
        
        // Fetch directly from Unsplash API
        const imageData = await fetchImageFromUnsplash(params, env);
        
        // Track download if needed
        if (params.download) {
            ctx.waitUntil(trackDownload(imageData.id, env));
        }
        
        // If both caches are empty, trigger refill in background
        if (metadata.mainCache.count === 0 && metadata.bufferCache.count === 0) {
            ctx.waitUntil(refillBufferCache(metadata, cacheKey, params, env).then(async (updatedMeta) => {
                // After buffer is refilled, copy buffer to main
                await copyBufferToMain(updatedMeta, cacheKey, env);
                // Refill buffer again
                await refillBufferCache(updatedMeta, cacheKey, params, env);
            }));
        }
        
        return formatResponse(imageData, params);
    } catch (error) {
        console.error(`Error in worker: ${error.message}`);
        
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

// Generate a consistent, normalized cache key from parameters
function generateCacheKey(params) {
    // Include only the parameters that affect the content of images
    const relevantParams = {
        orientation: params.orientation || 'default',
        collectionIds: params.collectionIds || 'none',
        addPhotoOfTheDay: params.addPhotoOfTheDay || false
    };
    
    // Sort keys to ensure consistent order
    const sortedKeys = Object.keys(relevantParams).sort();
    
    // Build key-value pairs and join them
    const keyParts = sortedKeys.map(key => {
        const value = relevantParams[key];
        // Skip default/empty values to make keys more concise
        if (value === 'none' || value === false || value === 'default') {
            return null;
        }
        return `${key}=${value}`;
    }).filter(part => part !== null);
    
    // Create the final key, defaulting to 'default' if no parameters
    const finalKey = keyParts.length > 0 ? keyParts.join('_') : 'default';
    
    console.log(`Generated cache key: ${finalKey}`);
    return finalKey;
}

// Get or initialize cache metadata with parameter awareness
async function getOrInitializeMetadata(cacheKey = 'default', env) {
    const metaKey = `META_${cacheKey}`;
    let metadata = await env.NAZKVHUBSTORE.get(metaKey, { type: 'json' });
    
    if (!metadata) {
        console.log(`Initializing fresh metadata for cache key: ${cacheKey}`);
        
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
            cacheKey: cacheKey     // Store which cache key this belongs to
        };
        
        // Initialize empty caches for this key
        await env.NAZKVHUBSTORE.put(`MAIN_${cacheKey}`, JSON.stringify(Array(30).fill(null)));
        await env.NAZKVHUBSTORE.put(`BUFFER_${cacheKey}`, JSON.stringify(Array(30).fill(null)));
        await updateMetadata(metadata, cacheKey, env);
    }
    
    return metadata;
}

// Update metadata in KV store with parameter awareness
async function updateMetadata(metadata, cacheKey = 'default', env) {
    const metaKey = `META_${cacheKey}`;
    return env.NAZKVHUBSTORE.put(metaKey, JSON.stringify(metadata));
}

// Get image from specific cache using pointer-based approach with parameter awareness
async function getImageFromCache(metadata, params, cacheType = 'main', cacheKey = 'default', env) {
    const cache = cacheType === 'main' ? metadata.mainCache : metadata.bufferCache;
    const cacheStorageKey = cacheType === 'main' ? `MAIN_${cacheKey}` : `BUFFER_${cacheKey}`;
    
    // No images in this cache
    if (cache.count === 0) {
        return { imageData: null, metadataChanged: false };
    }
    
    // Get the entire cache array with one operation
    const cacheArray = await env.NAZKVHUBSTORE.get(cacheStorageKey, { type: 'json' });
    if (!cacheArray) {
        // Cache should exist but doesn't - recreate it
        await env.NAZKVHUBSTORE.put(cacheStorageKey, JSON.stringify(Array(30).fill(null)));
        cache.count = 0;
        return { imageData: null, metadataChanged: true };
    }
    
    // Since we're using parameter-specific caches, we can simplify this function
    // We don't need to check criteria again - just find any non-null entry
    let foundIndex = -1;
    let startPointer = cache.currentPointer;
    let loopCount = 0;
    
    // Look for any valid image in the cache
    while (loopCount < 30) {  // Maximum 30 slots to check
        // Move pointer to next position
        cache.currentPointer = (cache.currentPointer + 1) % 30;
        
        // Check if this slot has an image
        if (cacheArray[cache.currentPointer] !== null) {
            foundIndex = cache.currentPointer;
            break;
        }
        
        loopCount++;
        
        // If we've checked all positions and found nothing
        if (cache.currentPointer === startPointer) {
            break;
        }
    }
    
    // No image found
    if (foundIndex === -1) {
        console.log(`No images found in ${cacheType} cache for key ${cacheKey} despite count=${cache.count}`);
        // Update count to match reality
        cache.count = 0;
        return { imageData: null, metadataChanged: true };
    }
    
    // Found an image - get it and clear the slot
    const imageData = cacheArray[foundIndex];
    cacheArray[foundIndex] = null;
    cache.count--;
    
    // Update the cache with one operation
    await env.NAZKVHUBSTORE.put(cacheStorageKey, JSON.stringify(cacheArray));
    
    return { imageData, metadataChanged: true };
}

// Copy entire buffer cache to main cache - SYNCHRONOUS OPERATION
async function copyBufferToMain(metadata, cacheKey = 'default', env) {
    console.log(`Copying buffer to main cache for key: ${cacheKey}`);
    
    try {
        // Get buffer cache with minimal operations
        const bufferArray = await env.NAZKVHUBSTORE.get(`BUFFER_${cacheKey}`, { type: 'json' });
        
        if (!bufferArray) {
            throw new Error(`Buffer cache not found for key: ${cacheKey}`);
        }
        
        // Copy buffer to main directly
        await env.NAZKVHUBSTORE.put(`MAIN_${cacheKey}`, JSON.stringify(bufferArray));
        
        // Update metadata
        metadata.mainCache.count = metadata.bufferCache.count;
        metadata.mainCache.currentPointer = 0;  // Reset pointer for fresh access
        await updateMetadata(metadata, cacheKey, env);
        
        console.log(`Buffer copy complete for key ${cacheKey}. Main cache now has ${metadata.mainCache.count} images`);
        return metadata;
    } catch (error) {
        console.error(`Error copying buffer to main for key ${cacheKey}: ${error.message}`);
        throw error;
    }
}

// Refill buffer cache with new images - ASYNCHRONOUS OPERATION
async function refillBufferCache(metadata, cacheKey = 'default', params = {}, env) {
    console.log(`Refilling buffer cache for key: ${cacheKey}`);
    
    if (metadata.isRefilling) {
        console.log(`Refill already in progress for key: ${cacheKey}, skipping`);
        return metadata;
    }
    
    try {
        // Mark refill in progress
        metadata.isRefilling = true;
        await updateMetadata(metadata, cacheKey, env);
        
        // Fetch images in bulk (30 at once)
        const fetchUrl = new URL('https://api.unsplash.com/photos/random');
        fetchUrl.searchParams.append('count', '30');
        
        // Add parameters that affect the content
        if (params.orientation) {
            fetchUrl.searchParams.append('orientation', params.orientation);
        }
        
        if (params.addPhotoOfTheDay) {
            fetchUrl.searchParams.append('collections', '1459961'); // Photo of the day collection ID
        } else if (params.collectionIds) {
            fetchUrl.searchParams.append('collections', params.collectionIds);
        }
        
        // Make the API request
        const response = await fetch(fetchUrl.toString(), {
            headers: {
                'Authorization': `Client-ID ${env.ACCESS_KEY}`,
                'Accept-Version': 'v1'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Unsplash API error: ${response.status} ${response.statusText}`);
        }
        
        const fullImages = await response.json();
        
        // If we got no images back (rare but possible), mark as not refilling and return
        if (!Array.isArray(fullImages) || fullImages.length === 0) {
            console.log(`No images returned from API for key: ${cacheKey}`);
            metadata.isRefilling = false;
            await updateMetadata(metadata, cacheKey, env);
            return metadata;
        }
        
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
            current_user_collections: img.current_user_collections || []
        }));
        
        // Update buffer cache with one operation
        await env.NAZKVHUBSTORE.put(`BUFFER_${cacheKey}`, JSON.stringify(optimizedImages));
        
        // Update metadata
        metadata.bufferCache.count = optimizedImages.length;
        metadata.bufferCache.currentPointer = 0;
        metadata.isRefilling = false;
        metadata.lastRefillTime = Date.now();
        await updateMetadata(metadata, cacheKey, env);
        
        console.log(`Buffer refill complete for key: ${cacheKey}, filled with ${optimizedImages.length} images`);
        return metadata;
    } catch (error) {
        // Reset refill flag on error
        metadata.isRefilling = false;
        await updateMetadata(metadata, cacheKey, env);
        console.error(`Refill error for key ${cacheKey}: ${error.message}`);
        throw error;
    }
}

// Helper function to trigger full cache system refresh - ASYNCHRONOUS OPERATION
async function refillCacheSystem(metadata, cacheKey = 'default', params = {}, env) {
    try {
        console.log(`Triggering full cache system refresh for key: ${cacheKey}`);
        
        // First copy buffer to main
        await copyBufferToMain(metadata, cacheKey, env);
        
        // Then refill buffer
        await refillBufferCache(metadata, cacheKey, params, env);
        
        return metadata;
    } catch (error) {
        console.error(`Cache system refresh error for key ${cacheKey}: ${error.message}`);
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
            collectionIdArray.includes(String(collection.id))
        );
        
        if (!collectionMatch) return false;
    }
    
    // Check for photo of the day
    if (addPhotoOfTheDay) {
        const imageCollections = imageData.current_user_collections || [];
        const isPotd = imageCollections.some(collection => 
            String(collection.id) === '1459961' // Photo of the day collection ID
        );
        
        if (!isPotd) return false;
    }
    
    return true; // Image matches all criteria
}

// API and External Services
// -----------------------------------------------------------

// Fetch image directly from Unsplash API
async function fetchImageFromUnsplash(params, env) {
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
            'Authorization': `Client-ID ${env.ACCESS_KEY}`,
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
async function trackDownload(photoId, env) {
    try {
        const downloadUrl = `https://api.unsplash.com/photos/${photoId}/download`;
        await fetch(downloadUrl, {
            headers: {
                'Authorization': `Client-ID ${env.ACCESS_KEY}`,
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

// API Endpoints
// -----------------------------------------------------------

// Handle cache status request - updated for parameter awareness
async function handleCacheStatusRequest(env) {
    try {
        // Get list of all cache keys from KV store
        // Note: This is a simplification - in practice you'd need pagination for many keys
        const keys = await env.NAZKVHUBSTORE.list({ prefix: 'META_' });
        
        const cacheStatuses = {};
        
        // Process each cache
        for (const key of keys.keys) {
            const cacheKey = key.name.replace('META_', '');
            const metadata = await getOrInitializeMetadata(cacheKey, env);
            
            // Calculate cache fill percentages
            const mainFillPercent = Math.round((metadata.mainCache.count / 30) * 100);
            const bufferFillPercent = Math.round((metadata.bufferCache.count / 30) * 100);
            
            // Format status for this cache
            cacheStatuses[cacheKey] = {
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
        }
        
        return new Response(JSON.stringify(cacheStatuses, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}

// Add this helper function to inspect cache contents
async function logCacheContents(cacheKey, cacheType = 'main', env) {
    try {
        const cacheStorageKey = cacheType === 'main' ? `MAIN_${cacheKey}` : `BUFFER_${cacheKey}`;
        const cacheArray = await env.NAZKVHUBSTORE.get(cacheStorageKey, { type: 'json' });
        
        if (!cacheArray) {
            console.log(`Cache ${cacheStorageKey} not found`);
            return;
        }
        
        const nonNullCount = cacheArray.filter(item => item !== null).length;
        console.log(`Cache ${cacheStorageKey} contains ${nonNullCount} items (non-null)`);
        
        // Log a sample of IDs for debugging
        const sampleIds = cacheArray
            .filter(item => item !== null)
            .slice(0, 5)
            .map(item => item.id);
            
        console.log(`Sample image IDs: ${sampleIds.join(', ')}`);
    } catch (error) {
        console.error(`Error logging cache contents: ${error.message}`);
    }
}

// Call this in key places, for example after refilling the buffer:
// await logCacheContents(cacheKey, 'buffer');