/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, GenerateContentResponse} from '@google/genai'; // Changed from @google/ai
import {marked} from 'marked';

// --- Fetch streaming compatibility polyfill ---
function supportsRequestStreams(): boolean {
  try {
    // Attempt constructing a Request with a ReadableStream body.
    // Browsers that do not support request streams will throw here.
    new Request('', { method: 'POST', body: new ReadableStream(), duplex: 'half' as any });
    return true;
  } catch {
    return false;
  }
}

if (!supportsRequestStreams()) {
  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body instanceof ReadableStream) {
      const reader = init.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const blob = new Blob(chunks);
      const newInit: RequestInit = { ...init, body: blob };
      delete (newInit as any).duplex;
      return originalFetch(input, newInit);
    }
    if (init && 'duplex' in init) {
      const newInit = { ...init };
      delete (newInit as any).duplex;
      return originalFetch(input, newInit);
    }
    return originalFetch(input, init);
  };
}
// --- End Fetch streaming compatibility polyfill ---

let ai: GoogleGenAI | null = null;
const globalErrorDiv = document.querySelector('#error') as HTMLDivElement;
const globalUserInput = document.querySelector('#input') as HTMLTextAreaElement;
const globalExamplesUl = document.querySelector('#examples') as HTMLUListElement;


try {
  ai = new GoogleGenAI({apiKey: process.env.API_KEY});
} catch (initError: any) {
  console.error("CRITICAL: Failed to initialize GoogleGenAI SDK:", JSON.stringify(initError, Object.getOwnPropertyNames(initError), 2));
  if (globalErrorDiv) {
    // Temporarily define parseError or a simplified version if it's not hoisted/available yet
    // For simplicity here, using a direct message, assuming parseError might not be defined yet.
    let initErrorMessage = 'Failed to initialize AI SDK. ';
    if (initError instanceof Error) {
        initErrorMessage += initError.message;
    } else if (typeof initError === 'string') {
        initErrorMessage += initError;
    } else {
        initErrorMessage += 'Please check console for details.';
    }
    // Attempt to use a more refined message if possible
    if (typeof parseError === 'function') {
        initErrorMessage = `Failed to initialize AI SDK: ${parseError(initError, "sdk_initialization")}`;
    }

    globalErrorDiv.innerHTML = initErrorMessage;
    globalErrorDiv.removeAttribute('hidden');
  }
  if (globalUserInput) globalUserInput.disabled = true;
  if (globalExamplesUl) globalExamplesUl.style.pointerEvents = 'none';
}


const userInput = document.querySelector('#input') as HTMLTextAreaElement;
const modelOutput = document.querySelector('#output') as HTMLDivElement;
const slideshow = document.querySelector('#slideshow') as HTMLDivElement;
const error = document.querySelector('#error') as HTMLDivElement; // This is the same as globalErrorDiv
const repeatButton = document.querySelector('#repeatButton') as HTMLButtonElement;
const narrationToggleButton = document.querySelector('#narrationToggleButton') as HTMLButtonElement;
const lightbox = document.querySelector('#lightbox') as HTMLDivElement;
const lightboxImage = document.querySelector('#lightboxImage') as HTMLImageElement;
const lightboxCaption = document.querySelector('#lightboxCaption') as HTMLDivElement;
const lightboxPrev = document.querySelector('#lightboxPrev') as HTMLButtonElement;
const lightboxNext = document.querySelector('#lightboxNext') as HTMLButtonElement;
const lightboxClose = document.querySelector('#lightboxClose') as HTMLButtonElement;
const slideDelayInputs = document.querySelectorAll('input[name="slideDelay"]') as NodeListOf<HTMLInputElement>;
let slideDelaySeconds = 5;
slideDelayInputs.forEach(input => {
  if (input.checked) {
    slideDelaySeconds = parseInt(input.value, 10);
  }
  input.addEventListener('change', () => {
    if (input.checked) {
      slideDelaySeconds = parseInt(input.value, 10);
    }
  });
});

// Delay between image generation calls to avoid rate limiting
const IMAGE_GENERATION_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Speech Synthesis Setup ---
let selectedVoice: SpeechSynthesisVoice | null = null;
let voices: SpeechSynthesisVoice[] = [];
let isNarrationEnabled = false; // Narration is disabled by default
let speakOnFirstSlide = false; // Used when narration enabled before slides exist

function loadVoices() {
  if (!window.speechSynthesis) return;
  voices = window.speechSynthesis.getVoices();
  const femaleEnglishVoices = voices.filter(voice =>
    voice.lang.toLowerCase().startsWith('en') && voice.name.toLowerCase().includes('female')
  );

  if (femaleEnglishVoices.length > 0) {
    const preferredVoices = femaleEnglishVoices.filter(v =>
        v.name.toLowerCase().includes('zira') ||
        v.name.toLowerCase().includes('google us english') ||
        v.name.toLowerCase().includes('samantha')
    );
    selectedVoice = preferredVoices[0] || femaleEnglishVoices[0];
  } else {
    const anyEnglishVoice = voices.find(voice => voice.lang.toLowerCase().startsWith('en'));
    selectedVoice = anyEnglishVoice || voices[0] || null;
  }
}

if (window.speechSynthesis) {
  loadVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
}

async function speakText(text: string) {
  if (!isNarrationEnabled || !window.speechSynthesis || !text.trim()) return;

  if (!selectedVoice && voices.length === 0) {
    loadVoices();
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  } else {
    utterance.lang = 'en-US';
  }
  utterance.pitch = 1;
  utterance.rate = 1;

  utterance.onerror = (event) => {
    console.error('SpeechSynthesisUtterance.onerror', event);
    error.innerHTML = `Speech error: ${event.error}. Try refreshing.`;
    error.removeAttribute('hidden');
  };
  window.speechSynthesis.speak(utterance);
}

function speakCurrentSlide() {
  if (!isNarrationEnabled || !slideshow) return;
  const slides = slideshow.querySelectorAll('.slide') as NodeListOf<HTMLDivElement>;
  if (slides.length === 0) return;

  const slideshowCenterX = slideshow.scrollLeft + slideshow.clientWidth / 2;
  let currentSlide: HTMLDivElement | null = null;
  let minDistance = Infinity;

  slides.forEach(slide => {
    if ((slide as HTMLElement).offsetParent === null) return;
    const slideCenterX = slide.offsetLeft + slide.offsetWidth / 2;
    const distance = Math.abs(slideshowCenterX - slideCenterX);
    if (distance < minDistance) {
      minDistance = distance;
      currentSlide = slide;
    }
  });

  if (currentSlide) {
    const caption = currentSlide.querySelector('div[data-speech-text]') as HTMLDivElement;
    if (caption) {
      const textToSpeak = caption.getAttribute('data-speech-text');
      if (textToSpeak) {
        speakText(textToSpeak);
      }
    }
  }
}
// --- End Speech Synthesis Setup ---

// --- Lightbox Setup ---
let lightboxIndex = 0;

function showLightboxImage(index: number) {
  const slides = Array.from(slideshow.querySelectorAll<HTMLDivElement>('.slide'));
  const images = slides.map(slide => slide.querySelector('img') as HTMLImageElement);
  if (images.length === 0) return;
  if (index < 0) index = images.length - 1;
  if (index >= images.length) index = 0;
  lightboxIndex = index;
  lightboxImage.src = images[index].src;
  const captionEl = slides[index].querySelector('div[data-speech-text]') as HTMLDivElement | null;
  if (captionEl && lightboxCaption) {
    lightboxCaption.innerHTML = captionEl.innerHTML;
  } else if (lightboxCaption) {
    lightboxCaption.innerHTML = '';
  }
}

function openLightbox(index: number) {
  showLightboxImage(index);
  lightbox.classList.remove('hidden');
}

function closeLightbox() {
  lightbox.classList.add('hidden');
}

lightboxPrev.addEventListener('click', () => {
  showLightboxImage(lightboxIndex - 1);
});

lightboxNext.addEventListener('click', () => {
  showLightboxImage(lightboxIndex + 1);
});

lightboxClose.addEventListener('click', () => {
  closeLightbox();
});

lightbox.addEventListener('click', e => {
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener('keydown', e => {
  if (lightbox.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') {
    showLightboxImage(lightboxIndex - 1);
  } else if (e.key === 'ArrowRight') {
    showLightboxImage(lightboxIndex + 1);
  } else if (e.key === 'Escape') {
    closeLightbox();
  }
});

let pointerStartX: number | null = null;
lightbox.addEventListener('pointerdown', e => { pointerStartX = e.clientX; });
lightbox.addEventListener('pointerup', e => {
  if (pointerStartX === null) return;
  const diff = e.clientX - pointerStartX;
  if (Math.abs(diff) > 50) {
    if (diff > 0) {
      showLightboxImage(lightboxIndex - 1);
    } else {
      showLightboxImage(lightboxIndex + 1);
    }
  }
  pointerStartX = null;
});
// --- End Lightbox Setup ---


const textModelInstructions = `
Use a fun story about lots of tiny cats as a metaphor.
Keep sentences short but conversational, casual, and engaging.
No commentary, just begin your explanation.
Ensure each distinct idea or step in the explanation is a separate sentence.
Keep going until you're done explaining the topic.`;

async function addSlide(text: string, image: HTMLImageElement) {
  const slide = document.createElement('div');
  slide.className = 'slide';
  const caption = document.createElement('div') as HTMLDivElement;
  caption.innerHTML = await marked.parse(text);
  caption.setAttribute('data-speech-text', text);
  slide.append(image);
  slide.append(caption);
  slideshow.append(slide);
  slideshow.removeAttribute('hidden');

  const index = slideshow.querySelectorAll('.slide').length - 1;
  image.addEventListener('click', () => openLightbox(index));

  if (repeatButton.hidden) {
    repeatButton.hidden = false;
  }
  // Enable repeat button only if narration is also enabled
  repeatButton.disabled = !isNarrationEnabled;


  slide.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  if (isNarrationEnabled || speakOnFirstSlide) {
    speakText(text);
    speakOnFirstSlide = false;
  }
}

function parseError(e: any, context?: string): string {
  console.log(`Parsing error (context: ${context || 'general'}):`, JSON.stringify(e, Object.getOwnPropertyNames(e), 2));

  let errorMessage = 'An unknown error occurred.';
  if (typeof e === 'string') {
    errorMessage = e;
  } else if (e instanceof Error) {
    errorMessage = e.message;
    const currentCause = (e as any).cause;
    if (currentCause && typeof currentCause === 'string') {
        errorMessage += ` (Details: ${currentCause})`;
    } else if (currentCause && typeof currentCause === 'object' && currentCause !== null &&
               typeof (currentCause as { message?: string }).message === 'string') {
        errorMessage += ` (Details: ${(currentCause as { message: string }).message})`;
    }
  }

  if (errorMessage.includes('RESOURCE_EXHAUSTED') || errorMessage.includes('429')) {
      return "The request rate is too high, which can happen with longer explanations. Please wait a moment and try again, or try a shorter prompt.";
  }
  
  if (errorMessage.includes('ReadableStream uploading is not supported') || (e && e.name === 'NotSupportedError')) {
    let originalDetails = '';
    if (e instanceof Error && e.message) originalDetails = e.message;
    else if (typeof e === 'string') originalDetails = e;
    else if (e && typeof e === 'object' && e.error && typeof e.error === 'object' && e.error.message) originalDetails = e.error.message;
    else if (e && typeof e === 'object' && (e as any).details) originalDetails = (e as any).details;


    return `Environment Compatibility Issue: Your browser, network, or a proxy may not support the necessary features for this application, even for standard requests. 
            Please try a different browser or network environment. 
            (Technical details: ${originalDetails || 'NotSupportedError or streaming-like error encountered with non-streaming API call.'})`;
  }

  const jsonErrorMatch = errorMessage.match(/{.*}/s);
  if (jsonErrorMatch && jsonErrorMatch[0]) {
    try {
      const parsedJson = JSON.parse(jsonErrorMatch[0]);
      if (parsedJson.error && parsedJson.error.message) {
        return `API Error: ${parsedJson.error.message}`;
      }
    } catch (jsonParseError) {
      // Fall through
    }
  }
  return errorMessage;
}

async function generate(message: string) {
  if (!ai) {
    error.innerHTML = "AI SDK not initialized. Cannot generate content. Please check for earlier error messages or refresh the page.";
    error.removeAttribute('hidden');
    userInput.disabled = false; 
    return;
  }

  userInput.disabled = true;
  modelOutput.innerHTML = '';
  slideshow.innerHTML = '';
  error.innerHTML = '';
  error.setAttribute('hidden', 'true');
  repeatButton.hidden = true;
  repeatButton.disabled = true;
  
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  try {
    const userTurn = document.createElement('div') as HTMLDivElement;
    userTurn.innerHTML = await marked.parse(`Explaining: ${message}`);
    userTurn.className = 'user-turn';
    modelOutput.append(userTurn);
    userInput.value = '';

    const fullPromptForTextModel = message + textModelInstructions;
    let textResponse: GenerateContentResponse;

    try {
      textResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-04-17',
        contents: fullPromptForTextModel,
      });
    } catch (textGenError: any) {
      console.error("CRITICAL: Error during TEXT generation (ai.models.generateContent):", JSON.stringify(textGenError, Object.getOwnPropertyNames(textGenError), 2));
      throw new Error(`Text generation failed. ${parseError(textGenError, "text_generation")}`, { cause: textGenError });
    }
    

    const fullText = textResponse.text;
    if (!fullText || !fullText.trim()) {
      error.innerHTML = 'No explanation was generated by the model. Try a different prompt.';
      error.removeAttribute('hidden');
      userInput.disabled = false;
      return;
    }

    const sentences: string[] = [];
    let sentenceBuffer = fullText;
    let parts = sentenceBuffer.split(/([.!?]+)/g);

    for (let i = 0; i < parts.length - 1; i += 2) {
      const sentenceText = (parts[i] + (parts[i+1] || '')).trim();
      if (sentenceText) {
        sentences.push(sentenceText);
      }
    }
    const lastPart = (parts.length % 2 === 1) ? parts[parts.length - 1].trim() : '';
    if (lastPart) {
        sentences.push(lastPart);
    }
    
    if (sentences.length === 0 && fullText.trim()) {
        sentences.push(fullText.trim());
    }


    for (const sentenceText of sentences) {
      if (!sentenceText) continue;
      try {
        const imagePrompt = `${sentenceText} - cute, minimal illustration with bright colors, simple line art drawing.`;
        const imageResponse = await ai.models.generateImages({
          model: 'imagen-3.0-generate-002',
          prompt: imagePrompt,
          // Fix: Changed outputMimeType to 'image/jpeg' to align with the specific generateImages example in guidelines.
          // This is a speculative fix for the reported arity error "Expected 0-1 arguments, but got 2" on line 231.
          // The original 'image/png' is generally valid, but this change ensures maximum conformity to the example.
          config: {numberOfImages: 1, outputMimeType: 'image/jpeg'},
        });

        if (imageResponse.generatedImages && imageResponse.generatedImages.length > 0) {
          const base64ImageBytes = imageResponse.generatedImages[0].image.imageBytes;
          const imageUrl = `data:image/jpeg;base64,${base64ImageBytes}`; // Adjusted to match potential change to jpeg
          const imgElement = document.createElement('img');
          imgElement.src = imageUrl;
          imgElement.alt = `Illustration for: ${sentenceText}`;
          await addSlide(sentenceText, imgElement);
          await sleep(slideDelaySeconds * 1000);
        } else {
           console.warn('No image generated by API for sentence:', sentenceText);
           const tempImg = document.createElement('img');
           tempImg.src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; 
           tempImg.alt = "Image not generated by API";
           await addSlide(sentenceText, tempImg);
           await sleep(slideDelaySeconds * 1000);
        }
      } catch (imgErr: any) {
          console.error("Error during IMAGE generation (ai.models.generateImages):", JSON.stringify(imgErr, Object.getOwnPropertyNames(imgErr), 2));
          error.innerHTML = `Image Generation Error: ${parseError(imgErr, "image_generation")}`;
          error.removeAttribute('hidden');
          const tempImg = document.createElement('img');
          tempImg.src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
          tempImg.alt = "Image generation failed";
          await addSlide(sentenceText, tempImg);
          await sleep(slideDelaySeconds * 1000);
      }
      await sleep(IMAGE_GENERATION_DELAY_MS);
    }

  } catch (e: any) { // This will catch the re-thrown error from text generation or other unhandled errors
    console.error("Overall generate() process error:", JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    error.innerHTML = parseError(e, "main_generate_catch"); 
    error.removeAttribute('hidden');
  } finally {
    userInput.disabled = false;
    userInput.focus();
    if (slideshow.querySelectorAll('.slide').length === 0 || !isNarrationEnabled) {
        repeatButton.disabled = true;
        if(slideshow.querySelectorAll('.slide').length === 0) {
            repeatButton.hidden = true;
        }
    } else {
        repeatButton.hidden = false;
        repeatButton.disabled = !isNarrationEnabled;
    }
  }
}

userInput.addEventListener('keypress', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const message = userInput.value.trim();
    if (message) {
      if (!ai) { // Also check here before calling generate
        error.innerHTML = "AI SDK not initialized. Cannot process input. Please check for earlier error messages or refresh the page.";
        error.removeAttribute('hidden');
        return;
      }
      await generate(message);
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // Ensure parseError is defined before it's potentially used by the SDK init catch block
  // This is mostly a structural safeguard; in practice, function declarations are hoisted.
  if (typeof parseError !== 'function') {
    // This is a fallback, should not happen with hoisted functions
    console.error("parseError function is not defined at DOMContentLoaded. This is unexpected.");
  }


  const examples = document.querySelectorAll('#examples li');
  examples.forEach((example) => {
    example.addEventListener('click', async () => {
      if (!ai) { // Also check here
        error.innerHTML = "AI SDK not initialized. Cannot process example. Please check for earlier error messages or refresh the page.";
        error.removeAttribute('hidden');
        return;
      }
      const message = example.textContent?.trim();
      if (message) {
        userInput.value = message;
        await generate(message);
      }
    });
  });

  if (narrationToggleButton) {
    narrationToggleButton.addEventListener('click', () => {
      isNarrationEnabled = !isNarrationEnabled;
      if (isNarrationEnabled) {
        narrationToggleButton.textContent = 'Disable Narration';
        const hasSlides = slideshow.querySelectorAll('.slide').length > 0;
        repeatButton.disabled = !hasSlides;
        if (hasSlides) {
          speakCurrentSlide();
        } else {
          speakOnFirstSlide = true;
          if (window.speechSynthesis) {
            // Attempt to resume the synthesis engine so future speech isn't blocked
            try { window.speechSynthesis.resume(); } catch {}
          }
        }
      } else {
        narrationToggleButton.textContent = 'Enable Narration';
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
        repeatButton.disabled = true;
        speakOnFirstSlide = false;
      }
    });
  }

  if (repeatButton) {
    repeatButton.addEventListener('click', () => {
      if (!isNarrationEnabled || !slideshow) return; 
      const slides = slideshow.querySelectorAll('.slide') as NodeListOf<HTMLDivElement>;
      if (slides.length === 0) return;

      const slideshowCenterX = slideshow.scrollLeft + slideshow.clientWidth / 2;
      let currentSlide: HTMLDivElement | null = null;
      let minDistance = Infinity;

      slides.forEach(slide => {
        if (slide.offsetParent === null) return; 
        const slideCenterX = slide.offsetLeft + slide.offsetWidth / 2;
        const distance = Math.abs(slideshowCenterX - slideCenterX);
        if (distance < minDistance) {
          minDistance = distance;
          currentSlide = slide;
        }
      });

      if (currentSlide) {
        const caption = currentSlide.querySelector('div[data-speech-text]') as HTMLDivElement;
        if (caption) {
          const textToSpeak = caption.getAttribute('data-speech-text');
          if (textToSpeak) {
            speakText(textToSpeak);
          }
        }
      }
    });
  }
  
  // Initial state for buttons if SDK loaded successfully
  if (ai) { // Only set these if SDK is fine
    narrationToggleButton.textContent = 'Enable Narration';
    repeatButton.disabled = true;
    repeatButton.hidden = true;
  } else { // SDK failed to load, ensure buttons reflect this
    narrationToggleButton.disabled = true;
    repeatButton.disabled = true;
    repeatButton.hidden = true;
  }
});
