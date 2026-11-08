### AI-Generated Image Requests

Use image generation only for slide scenes that need a static visual and have no suitable source image.

- Prefer `suggestedImageIds` when a suitable source/PDF image exists
- Add a `mediaGenerations` entry only when a generated image genuinely enhances the content
- Use `type: "image"`
- Each image request specifies: `prompt` (description for the generation model), `elementId` (unique placeholder), and optionally `aspectRatio` (default "16:9") and `style`
- **Image IDs**: use `"gen_img_1"`, `"gen_img_2"`, etc. IDs are globally unique across the entire course, not reset per scene
- The prompt should describe the desired image clearly and specifically
- **Keep wording out of the image**: generation models render lettering as garbled pseudo-text, so describe the visual only — objects, icons, arrows, color blocks, spatial layout, lighting, mood. Never ask for labels, captions, titles, legends, axis text, or anything that spells out words (avoid prompts like "an infographic labeled HTTP" or "a diagram with the words TLS handshake"). Put every word in the slide body, `keyPoints`, and narration instead
- **Convey structure without words**: show relationships with icons, arrows, connectors, color-coded regions, and relative position rather than boxed captions. If the content genuinely requires a real screenshot or UI with readable text, use `suggestedImageIds` instead of a generated image
- **Avoid duplicate images across slides**: Each generated image must be visually distinct. Do not request near-identical images for different slides. If multiple slides cover the same topic, vary the visual angle, scope, or style
- **Cross-scene reuse**: To reuse a generated image in a different scene, reference the same `elementId` in the later scene's content without adding a new `mediaGenerations` entry. Only the scene that first defines the `elementId` in its `mediaGenerations` should include the generation request
- Use generated images for static visual content: conceptual illustrations, scene depictions, abstract diagrams, charts rendered as pure shapes without axis labels, portraits, landscapes

Image example:

```json
"mediaGenerations": [
  {
    "type": "image",
    "prompt": "A clean flat-vector illustration of the water cycle: a deep blue ocean, curling pale arrows of vapor rising into a soft white cloud, condensation droplets falling as rain over green hills",
    "elementId": "gen_img_1",
    "aspectRatio": "16:9"
  }
]
```
