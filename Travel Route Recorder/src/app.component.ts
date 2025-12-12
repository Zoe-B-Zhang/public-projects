import { ChangeDetectionStrategy, Component, signal, effect, computed } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GeminiService, LocationCoordinate } from './services/gemini.service';

// Declare Leaflet globally
declare const L: any;
// Declare html2canvas globally
declare const html2canvas: any;

interface ValidCoordinate {
    name: string;
    lat: number;
    lng: number;
}

interface Stamp {
    id: string; // Unique ID for DOM selection
    name: string;
    rotation: number;
    color: string;
    date: string;
    time: string; // New
    imageUrl?: string; // New: If present, overrides CSS style
    description?: string; // New: For AI generation
    selected: boolean; // New: For bulk actions
}

interface SavedTrip {
    id: string;
    name: string;
    date: number;
    locations: string; // raw input
    coordinates: ValidCoordinate[];
    stamps: Stamp[];
    styleConfig?: {
        style: string;
        color: string;
        weight: number;
        customIconUrl?: string;
        mapHeight?: 'small' | 'medium' | 'large';
    };
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, FormsModule, NgOptimizedImage],
  host: {
      '(window:resize)': 'fitMapBounds()'
  }
})
export class AppComponent {
  // Input State
  locationInput = signal('');
  isLoading = signal(false);
  isExporting = signal(false);
  isGeneratingIcon = signal(false);
  
  // Map Styling State
  mapStyle = signal<'standard' | 'vintage' | 'neon'>('standard');
  routeColor = signal('#4f46e5'); // Default Indigo
  routeWeight = signal(4);
  customIconUrl = signal<string | null>(null);
  mapHeight = signal<'small' | 'medium' | 'large'>('small');

  // Output State
  routeCoordinates = signal<ValidCoordinate[]>([]);
  missingLocations = signal<string[]>([]);
  stamps = signal<Stamp[]>([]);
  statusMessage = signal('Ready to map your journey.');
  
  // Saved Trips
  savedTrips = signal<SavedTrip[]>([]);
  tripToDelete = signal<string | null>(null); // ID of trip pending deletion

  // Stamp Editor State
  editingStamp = signal<Stamp | null>(null);
  isGeneratingStamp = signal(false);
  stampPrompt = signal(''); // User input for AI style

  // Computed
  mapHeightPx = computed(() => {
      switch (this.mapHeight()) {
          case 'medium': return 600;
          case 'large': return 800;
          default: return 400;
      }
  });

  allStampsSelected = computed(() => {
      return this.stamps().length > 0 && this.stamps().every(s => s.selected);
  });

  private map: any; // Leaflet map instance
  private currentTileLayer: any; // Keep track to remove/replace
  private currentPolyline: any;  // Keep track to style
  private markerLayerGroup: any; // Store markers to easily remove/update
  private routeBounds: any; // Store the bounds of the current route

  constructor(private geminiService: GeminiService) {
    // Load saved trips from local storage
    this.loadSavedTrips();

    // Effect to initialize map when coordinates change
    effect(() => {
        const coords = this.routeCoordinates();
        // Only init map if we have valid coordinates and we aren't loading 
        if (coords.length > 0 && !this.isLoading()) {
             // Small delay to ensure container is in DOM
             setTimeout(() => this.initMap(coords), 100);
        }
    });

    // Effect to update map visuals when styles change (reactive)
    effect(() => {
        const style = this.mapStyle();
        const color = this.routeColor();
        const weight = this.routeWeight();
        const iconUrl = this.customIconUrl(); // Track icon changes
        
        if (this.map) {
            this.updateMapTiles(style);
            this.updatePolylineStyle(color, weight);
            this.updateMarkers(iconUrl);
        }
    });

    // Separate effect for Map Resizing
    effect(() => {
        const h = this.mapHeight();
        // Wait for CSS transition (300ms) to mostly finish before invalidating size
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
            }, 350);
        }
    });
  }

  async onGenerateRoute() {
    const rawInput = this.locationInput().trim();
    if (!rawInput) return;

    this.isLoading.set(true);
    this.statusMessage.set('Tracing your route on the globe...');
    this.routeCoordinates.set([]); // Clear previous map
    this.missingLocations.set([]); // Clear previous errors
    this.stamps.set([]); // Clear previous stamps
    this.customIconUrl.set(null); // Reset custom icon on new route

    try {
        // 1. Parse Input
        const locations = rawInput.split(',').map(s => s.trim()).filter(s => s.length > 0);
        
        // 2. Get Coordinates via AI
        const rawCoords = await this.geminiService.getCoordinatesForLocations(locations);
        
        const validCoords: ValidCoordinate[] = [];
        const missing: string[] = [];

        // 3. Filter Valid vs Missing
        rawCoords.forEach((item, index) => {
            if (item.lat !== null && item.lng !== null && item.lat !== 0 && item.lng !== 0) {
                validCoords.push({ name: item.name, lat: item.lat, lng: item.lng });
            } else {
                missing.push(item.name || locations[index]);
            }
        });

        this.missingLocations.set(missing);

        if (validCoords.length === 0) {
            this.statusMessage.set('Could not find any of those locations.');
        } else {
            this.routeCoordinates.set(validCoords);
            
            if (missing.length > 0) {
                this.statusMessage.set(`Found ${validCoords.length} places. ${missing.length} missing.`);
            } else {
                this.statusMessage.set('Route mapped!');
            }
            
            // 4. Create Visual Stamps (No AI)
            this.createVisualStamps(validCoords);
        }

    } catch (error: any) {
        console.error('Error:', error);
        if (error.status === 'RESOURCE_EXHAUSTED' || error.code === 429) {
             this.statusMessage.set('AI Quota Exceeded. Please try again later.');
        } else {
             this.statusMessage.set('Something went wrong. Please check your internet connection.');
        }
    } finally {
        this.isLoading.set(false);
    }
  }

  // Handle Image Upload for Custom Icon
  async onUploadIcon(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files || input.files.length === 0) return;

      const file = input.files[0];
      if (file.size > 5 * 1024 * 1024) {
          alert('File is too large. Please upload an image under 5MB.');
          return;
      }

      this.isGeneratingIcon.set(true);
      this.statusMessage.set('Designing your custom icon...');

      try {
          const reader = new FileReader();
          reader.onload = async () => {
              const base64Full = reader.result as string;
              // Extract raw base64 and mime type
              const matches = base64Full.match(/^data:(.+);base64,(.+)$/);
              if (!matches || matches.length !== 3) {
                  throw new Error("Invalid image format");
              }
              const mimeType = matches[1];
              const base64Data = matches[2];

              const newIconUrl = await this.geminiService.generateCustomIcon(base64Data, mimeType);
              this.customIconUrl.set(newIconUrl);
              this.statusMessage.set('Custom icon applied!');
              this.isGeneratingIcon.set(false);
          };
          reader.readAsDataURL(file);
      } catch (e) {
          console.error(e);
          this.statusMessage.set('Failed to process icon. Try another image.');
          this.isGeneratingIcon.set(false);
      }
  }

  private createVisualStamps(coords: ValidCoordinate[]) {
    const colors = ['border-indigo-600 text-indigo-800', 'border-rose-600 text-rose-800', 'border-emerald-600 text-emerald-800', 'border-amber-600 text-amber-800', 'border-blue-600 text-blue-800'];
    const now = new Date().toLocaleDateString();

    const newStamps: Stamp[] = coords.map((c, i) => {
        return {
            id: `stamp-${this.generateId()}`,
            name: c.name,
            rotation: Math.floor(Math.random() * 30) - 15, // -15 to 15 deg
            color: colors[i % colors.length],
            date: now,
            time: '12:00',
            selected: false,
            description: 'Classic ink stamp'
        };
    });
    this.stamps.set(newStamps);
  }

  // --- Stamp Customization Logic ---

  openStampEditor(stamp: Stamp) {
      // Create a shallow copy to edit
      this.editingStamp.set({ ...stamp });
      this.stampPrompt.set(stamp.description || 'Classic ink stamp');
  }

  closeStampEditor() {
      this.editingStamp.set(null);
      this.isGeneratingStamp.set(false);
  }

  async generateAiStamp() {
      const current = this.editingStamp();
      if (!current || !this.stampPrompt()) return;

      this.isGeneratingStamp.set(true);
      try {
          const imageUrl = await this.geminiService.generateStampImage(current.name, this.stampPrompt());
          this.editingStamp.set({ 
              ...current, 
              imageUrl: imageUrl, 
              description: this.stampPrompt() 
          });
      } catch (e) {
          alert('Failed to generate stamp. Quota may be exceeded.');
          console.error(e);
      } finally {
          this.isGeneratingStamp.set(false);
      }
  }

  onUploadStampImage(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files || input.files.length === 0) return;
      
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = (e: any) => {
          const current = this.editingStamp();
          if(current) {
              this.editingStamp.set({ ...current, imageUrl: e.target.result });
          }
      };
      reader.readAsDataURL(file);
  }

  saveStampChanges() {
      const edited = this.editingStamp();
      if (!edited) return;

      this.stamps.update(list => list.map(s => s.id === edited.id ? edited : s));
      this.closeStampEditor();
  }

  revertStampStyle() {
      const current = this.editingStamp();
      if(current) {
          // Remove imageUrl to revert to CSS style
          this.editingStamp.set({ ...current, imageUrl: undefined });
      }
  }

  // --- Bulk Actions & Download ---

  toggleStampSelection(id: string) {
      this.stamps.update(list => list.map(s => s.id === id ? { ...s, selected: !s.selected } : s));
  }

  toggleAllStamps() {
      const allSelected = this.allStampsSelected();
      this.stamps.update(list => list.map(s => ({ ...s, selected: !allSelected })));
  }

  async downloadSelectedStamps() {
      const selected = this.stamps().filter(s => s.selected);
      if (selected.length === 0) {
          alert('Please select at least one stamp to download.');
          return;
      }

      this.isExporting.set(true);
      
      try {
          // Process sequentially to avoid browser hiccups
          for (const stamp of selected) {
              const element = document.getElementById(stamp.id);
              if (element) {
                   const canvas = await html2canvas(element, {
                       scale: 3, // High Res
                       backgroundColor: null,
                       useCORS: true
                   });
                   
                   const link = document.createElement('a');
                   link.download = `Travel_Stamp_${stamp.name.replace(/\s+/g, '_')}.png`;
                   link.href = canvas.toDataURL('image/png');
                   link.click();
              }
          }
      } catch (e) {
          console.error("Download failed", e);
          alert('Failed to download some stamps.');
      } finally {
          this.isExporting.set(false);
      }
  }

  // --- Map & General Logic ---

  fitMapBounds() {
    if (this.map && this.routeBounds) {
        this.map.invalidateSize();
        try {
            setTimeout(() => {
                this.map.fitBounds(this.routeBounds, { padding: [80, 80] });
            }, 50);
        } catch (e) {
            console.warn("Could not fit bounds", e);
        }
    }
  }

  private initMap(coords: ValidCoordinate[]) {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) return;
    
    // Cleanup existing map
    if (this.map) {
        this.map.off();
        this.map.remove();
        this.map = null;
        this.currentTileLayer = null;
        this.currentPolyline = null;
        this.markerLayerGroup = null;
    }

    const startLat = coords[0].lat;
    const startLng = coords[0].lng;

    this.map = L.map('map', { 
        preferCanvas: true 
    }).setView([startLat, startLng], 13);

    this.updateMapTiles(this.mapStyle());

    // Create a layer group for markers so we can clear/update them easily
    this.markerLayerGroup = L.layerGroup().addTo(this.map);

    const latLngs: any[] = [];
    
    coords.forEach((loc) => {
        latLngs.push([loc.lat, loc.lng]);
    });

    // Draw Polyline Route
    if (latLngs.length > 1) {
        this.currentPolyline = L.polyline(latLngs, { 
            color: this.routeColor(), 
            weight: this.routeWeight(), 
            dashArray: '10, 10' 
        }).addTo(this.map);
        this.routeBounds = this.currentPolyline.getBounds();
    } else if (latLngs.length === 1) {
        this.routeBounds = L.latLngBounds(latLngs);
    }
    
    // Add markers
    this.updateMarkers(this.customIconUrl());

    // Initial Fit
    this.fitMapBounds();
  }

  private updateMarkers(customIconUrl: string | null) {
      if (!this.map || !this.markerLayerGroup) return;

      this.markerLayerGroup.clearLayers();
      
      const coords = this.routeCoordinates();
      coords.forEach((loc, index) => {
          let markerIcon;

          if (customIconUrl) {
              // Custom DivIcon with the generated image
              markerIcon = L.divIcon({
                  className: 'custom-ai-marker',
                  html: `<div class="w-10 h-10 rounded-full border-2 border-white shadow-lg bg-cover bg-center transition-transform hover:scale-110" style="background-image: url('${customIconUrl}'); background-color: white;"></div>`,
                  iconSize: [40, 40],
                  iconAnchor: [20, 20]
              });
          } else {
              // Default Leaflet marker
              markerIcon = new L.Icon.Default();
          }

          const marker = L.marker([loc.lat, loc.lng], { icon: markerIcon }).addTo(this.markerLayerGroup);
          
          marker.bindTooltip(`${index + 1}. ${loc.name}`, { 
              permanent: true, 
              direction: 'bottom',
              offset: customIconUrl ? [0, 22] : [0, 5], // Adjust offset for circle vs pin
              className: 'custom-map-tooltip' 
          });
      });
  }

  private updateMapTiles(style: 'standard' | 'vintage' | 'neon') {
      if (!this.map) return;

      if (this.currentTileLayer) {
          this.map.removeLayer(this.currentTileLayer);
      }

      let url = '';
      let attribution = '';

      switch (style) {
          case 'vintage':
              url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
              attribution = 'Tiles © Esri';
              break;
          case 'neon':
              url = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
              attribution = '© OpenStreetMap, © CartoDB';
              break;
          case 'standard':
          default:
              url = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
              attribution = '© OpenStreetMap';
              break;
      }

      this.currentTileLayer = L.tileLayer(url, {
        maxZoom: 19,
        attribution: attribution,
        crossOrigin: true 
      }).addTo(this.map);
      
      this.currentTileLayer.bringToBack();
  }

  private updatePolylineStyle(color: string, weight: number) {
      if (this.currentPolyline) {
          this.currentPolyline.setStyle({
              color: color,
              weight: weight
          });
      }
  }

  private generateId(): string {
      // Robust ID generation that works in non-secure contexts too
      return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  saveTrip() {
    const currentCoords = this.routeCoordinates();
    if (currentCoords.length === 0) return;

    // Create a Deep Copy of the data to break references
    const tripName = `${currentCoords[0].name} Trip`;
    const newTrip: SavedTrip = {
        id: this.generateId(),
        name: tripName,
        date: Date.now(),
        locations: this.locationInput(),
        coordinates: currentCoords.map(c => ({...c})),
        stamps: this.stamps().map(s => ({...s})),
        styleConfig: {
            style: this.mapStyle(),
            color: this.routeColor(),
            weight: this.routeWeight(),
            customIconUrl: this.customIconUrl() || undefined,
            mapHeight: this.mapHeight()
        }
    };

    // Update state immediately for user feedback
    const updatedTrips = [newTrip, ...this.savedTrips()];
    this.savedTrips.set(updatedTrips);

    try {
        this.persistTrips(updatedTrips);
        alert('Trip saved to library!');
    } catch (e) {
        console.warn("LocalStorage quota exceeded", e);
        // Fallback: Inform user and suggest download
        alert('Storage Full! This trip is saved for this session, but will disappear on refresh. Please download the Data Config to save it permanently.');
    }
  }

  // Downloads the full JSON state of the trip
  downloadTripData(event: Event, trip: SavedTrip) {
      event.stopPropagation();
      try {
          // Use Blob to handle large payloads correctly
          const blob = new Blob([JSON.stringify(trip)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          
          const downloadAnchorNode = document.createElement('a');
          downloadAnchorNode.setAttribute("href", url);
          downloadAnchorNode.setAttribute("download", `trip_${trip.name.replace(/\s+/g, '_')}_${trip.date}.json`);
          document.body.appendChild(downloadAnchorNode); 
          downloadAnchorNode.click();
          
          setTimeout(() => {
              document.body.removeChild(downloadAnchorNode);
              URL.revokeObjectURL(url);
          }, 100);
      } catch (e) {
          console.error("Export failed", e);
          alert("Failed to export trip data.");
      }
  }

  // Imports a trip from JSON
  onImportTrip(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files || input.files.length === 0) return;

      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = (e: any) => {
          try {
              const trip: SavedTrip = JSON.parse(e.target.result);
              
              // Validate essential fields
              if (!trip.coordinates || !Array.isArray(trip.stamps)) throw new Error("Invalid format: missing coordinates or stamps");
              
              // Ensure ID uniqueness on import if collision (unlikely but safe)
              const existing = this.savedTrips().find(t => t.id === trip.id);
              if (existing) {
                  trip.id = this.generateId();
              }

              // Load it into view
              this.loadTrip(null, trip);

              // Add to saved trips list
              try {
                  const updated = [trip, ...this.savedTrips()];
                  this.persistTrips(updated);
                  this.savedTrips.set(updated);
              } catch (err) {
                  console.warn("Could not save imported trip to LS", err);
                  alert('Trip loaded! (Storage full - not added to History list)');
              }
          } catch (error) {
              console.error(error);
              alert('Failed to import trip file. Invalid or Corrupt JSON.');
          }
      };
      reader.readAsText(file);
      input.value = ''; // Reset
  }

  loadTrip(event: Event | null, trip: SavedTrip) {
    if (event) event.stopPropagation();

    // 1. Scroll up
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    // 2. Clear current state to give visual "refresh" feedback
    this.routeCoordinates.set([]); 
    this.isGeneratingIcon.set(false);
    this.isExporting.set(false);
    this.statusMessage.set(`Loading ${trip.name}...`);

    // 3. Set Inputs
    this.locationInput.set(trip.locations);
    
    // 4. Restore Config
    if (trip.styleConfig) {
        this.mapStyle.set(trip.styleConfig.style as any);
        this.routeColor.set(trip.styleConfig.color);
        this.routeWeight.set(trip.styleConfig.weight);
        this.customIconUrl.set(trip.styleConfig.customIconUrl || null);
        this.mapHeight.set(trip.styleConfig.mapHeight || 'small');
    } else {
        // Defaults if missing
        this.mapStyle.set('standard');
        this.routeColor.set('#4f46e5');
        this.routeWeight.set(4);
        this.customIconUrl.set(null);
        this.mapHeight.set('small');
    }

    // 5. Force a delay to let the UI 'blink' (clear map) then rebuild it.
    // This ensures the map container is torn down and re-initialized cleanly.
    setTimeout(() => {
        this.routeCoordinates.set(trip.coordinates.map(c => ({...c}))); // Deep copy
        this.stamps.set(trip.stamps.map(s => ({...s}))); // Deep copy
        this.missingLocations.set([]);
        
        this.statusMessage.set(`Loaded trip: ${trip.name}`);
    }, 150);
  }

  // --- DELETE FLOW REFACTOR ---

  // 1. Request - Opens Modal
  requestDeleteTrip(event: Event, tripId: string) {
      event.stopPropagation();
      this.tripToDelete.set(tripId);
  }

  // 2. Confirm - Deletes Data
  confirmDeleteTrip() {
      const idToDelete = this.tripToDelete();
      if (!idToDelete) return;

      const currentTrips = this.savedTrips();
      const updatedTrips = currentTrips.filter(t => t.id !== idToDelete);

      this.savedTrips.set(updatedTrips);
      this.persistTrips(updatedTrips);
      
      this.tripToDelete.set(null); // Close modal
  }

  // 3. Cancel - Closes Modal
  cancelDeleteTrip() {
      this.tripToDelete.set(null);
  }

  exportMapImage() {
      const element = document.getElementById('map-card');
      if (!element) return;
      this.isExporting.set(true);

      if (this.map && this.routeBounds) {
          this.map.fitBounds(this.routeBounds, { padding: [50, 50], animate: false });
          this.map.invalidateSize();
      }

      setTimeout(() => {
          html2canvas(element, { 
              useCORS: true, 
              scale: 2, 
              allowTaint: true,
              backgroundColor: null,
              ignoreElements: (node: any) => {
                 return node.classList && node.classList.contains('leaflet-control-container');
              }
          }).then((canvas: HTMLCanvasElement) => {
              const image = canvas.toDataURL("image/png");
              const link = document.createElement('a');
              link.download = `travel-route-map-${Date.now()}.png`;
              link.href = image;
              link.click();
              this.isExporting.set(false);
          }).catch((err: any) => {
              console.error("Export failed", err);
              this.isExporting.set(false);
              alert('Could not generate image. Please try again.');
          });
      }, 1000);
  }

  private loadSavedTrips() {
      const stored = localStorage.getItem('travel_route_trips');
      if (stored) {
          try {
              let trips: SavedTrip[] = JSON.parse(stored);
              // Data Sanitization: Ensure all trips have valid IDs and convert number IDs to strings if any
              let hasUpdates = false;
              trips = trips.map(t => {
                  if (!t.id) {
                      t.id = this.generateId();
                      hasUpdates = true;
                  } else if (typeof t.id === 'number') {
                      t.id = String(t.id);
                      hasUpdates = true;
                  }
                  return t;
              });

              this.savedTrips.set(trips);
              if (hasUpdates) {
                  this.persistTrips(trips);
              }
          } catch (e) {
              console.error("Failed to parse saved trips", e);
          }
      }
  }

  private persistTrips(trips: SavedTrip[]) {
      localStorage.setItem('travel_route_trips', JSON.stringify(trips));
  }
}