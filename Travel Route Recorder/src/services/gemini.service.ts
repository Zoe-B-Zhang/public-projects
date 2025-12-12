import { Injectable } from '@angular/core';
import { GoogleGenAI, Type } from "@google/genai";

const API_KEY = process.env.API_KEY;

export interface LocationCoordinate {
  name: string;
  lat: number | null;
  lng: number | null;
}

@Injectable({
  providedIn: 'root',
})
export class GeminiService {
  private ai: GoogleGenAI;
  
  constructor() {
    if (!API_KEY) {
      console.warn("API_KEY is not set. Using a placeholder.");
    }
    this.ai = new GoogleGenAI({ apiKey: API_KEY || 'MISSING_API_KEY' });
  }

  // Turns a list of city names into coordinates, handling invalid ones
  async getCoordinatesForLocations(locations: string[]): Promise<LocationCoordinate[]> {
     const prompt = `
     Task: Geocode the following travel locations.
     Locations List: ${JSON.stringify(locations)}.
     
     Rules:
     1. Return a JSON object with a property 'waypoints'.
     2. 'waypoints' MUST be an array matching the exact order and length of the input List.
     3. For each location, provide:
        - 'name': The corrected/formatted name of the location.
        - 'lat': The latitude (number). If the location is fictional, not found, or ambiguous, return null.
        - 'lng': The longitude (number). If the location is fictional, not found, or ambiguous, return null.
     `;
     
     try {
        const response = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        waypoints: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING },
                                    lat: { type: Type.NUMBER, nullable: true },
                                    lng: { type: Type.NUMBER, nullable: true }
                                },
                                required: ['name', 'lat', 'lng']
                            }
                        }
                    },
                    required: ['waypoints']
                }
            }
        });
        const json = JSON.parse(response.text);
        return json.waypoints || [];
     } catch (e) {
         console.error("Failed to get coordinates", e);
         // Propagate error so component knows AI failed
         throw e; 
     }
  }

  // Generates a simple icon based on an uploaded image
  async generateCustomIcon(base64Image: string, mimeType: string): Promise<string> {
    try {
        // 1. Analyze the image to get a subject description
        const analyzeResponse = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: {
                role: 'user',
                parts: [{
                    inlineData: { mimeType, data: base64Image }
                }, {
                    text: "Identify the single main object in this image. Return ONLY the object name in 2-4 words (e.g. 'Red Sports Car', 'Golden Retriever Face'). Do not describe background."
                }]
            }
        });
        const subject = analyzeResponse.text.trim();
        console.log('Icon Subject:', subject);

        // 2. Generate a new icon based on the subject
        const generateResponse = await this.ai.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt: `A simple, flat, minimalist vector icon of ${subject}. The icon should be circular or contained within a simple shape. Solid, vivid colors. White background. No text. High contrast.`,
            config: {
                numberOfImages: 1,
                aspectRatio: '1:1',
                outputMimeType: 'image/jpeg'
            }
        });

        const generatedBytes = generateResponse.generatedImages[0].image.imageBytes;
        return `data:image/jpeg;base64,${generatedBytes}`;

    } catch (e: any) {
        console.warn("AI Icon Generation failed (likely quota/rate limit), falling back to original image.", e);
        if (e.status === 'RESOURCE_EXHAUSTED' || e.code === 429) {
            console.info("Using original image as fallback due to AI quota.");
        }
        return `data:${mimeType};base64,${base64Image}`;
    }
  }

  // Generate a customized stamp visual
  async generateStampImage(locationName: string, styleDescription: string): Promise<string> {
      const prompt = `A stylized travel passport stamp or sticker for "${locationName}". 
      Style details: ${styleDescription}.
      The design should be circular or shield-shaped, isolated on a white background. 
      Vintage, ink-stamped, or badge aesthetic. High contrast.`;

      try {
          const response = await this.ai.models.generateImages({
              model: 'imagen-4.0-generate-001',
              prompt: prompt,
              config: {
                  numberOfImages: 1,
                  aspectRatio: '1:1',
                  outputMimeType: 'image/jpeg'
              }
          });
          const generatedBytes = response.generatedImages[0].image.imageBytes;
          return `data:image/jpeg;base64,${generatedBytes}`;
      } catch (e) {
          console.error("Failed to generate stamp", e);
          throw e;
      }
  }
}