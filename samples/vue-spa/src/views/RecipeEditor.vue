<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Recipe } from '../data/recipes';
import { useRecipesStore } from '../stores/recipes';

const props = defineProps<{ id?: string }>();
const store = useRecipesStore();
const router = useRouter();
const isEditing = computed(() => Boolean(props.id));
const saving = ref(false);
const saveError = ref<string | null>(null);

const form = reactive({
  title: '',
  description: '',
  cookTimeMinutes: 20,
  tagsText: '',
  image: '',
  ingredients: [''],
  steps: [''],
});

onMounted(async () => {
  if (!props.id) return;
  const existing = await store.fetchOne(props.id);
  if (!existing) return;
  form.title = existing.title;
  form.description = existing.description;
  form.cookTimeMinutes = existing.cookTimeMinutes;
  form.tagsText = existing.tags.join(', ');
  form.image = existing.image;
  form.ingredients = existing.ingredients.length > 0 ? [...existing.ingredients] : [''];
  form.steps = existing.steps.length > 0 ? [...existing.steps] : [''];
});

function addIngredient(): void {
  form.ingredients.push('');
}
function removeIngredient(i: number): void {
  form.ingredients.splice(i, 1);
}
function addStep(): void {
  form.steps.push('');
}
function removeStep(i: number): void {
  form.steps.splice(i, 1);
}

const titleError = computed(() =>
  form.title.trim().length === 0 ? 'Title is required.' : null,
);
const cookTimeError = computed(() =>
  form.cookTimeMinutes <= 0 ? 'Cook time must be greater than zero.' : null,
);
const isValid = computed(() => titleError.value === null && cookTimeError.value === null);

async function onSubmit(): Promise<void> {
  if (!isValid.value) return;
  saving.value = true;
  saveError.value = null;
  const payload: Omit<Recipe, 'id'> = {
    title: form.title.trim(),
    description: form.description.trim(),
    cookTimeMinutes: form.cookTimeMinutes,
    tags: form.tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    ingredients: form.ingredients.map((i) => i.trim()).filter(Boolean),
    steps: form.steps.map((s) => s.trim()).filter(Boolean),
    image: form.image.trim(),
  };
  try {
    const saved =
      isEditing.value && props.id
        ? await store.update(props.id, payload)
        : await store.create(payload);
    await router.push(`/recipes/${saved.id}`);
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="editor">
    <h1>{{ isEditing ? 'Edit recipe' : 'New recipe' }}</h1>
    <form @submit.prevent="onSubmit">
      <label>
        Title
        <input v-model="form.title" type="text" placeholder="Tomato Basil Soup" />
        <span v-if="titleError" class="field-error">{{ titleError }}</span>
      </label>

      <label>
        Description
        <textarea v-model="form.description" rows="2" />
      </label>

      <label>
        Cook time (minutes)
        <input v-model.number="form.cookTimeMinutes" type="number" min="1" />
        <span v-if="cookTimeError" class="field-error">{{ cookTimeError }}</span>
      </label>

      <label>
        Tags (comma separated)
        <input v-model="form.tagsText" type="text" placeholder="soup, quick, vegetarian" />
      </label>

      <label>
        Image URL
        <input v-model="form.image" type="url" placeholder="https://…" />
      </label>

      <fieldset>
        <legend>Ingredients</legend>
        <div v-for="(_, i) in form.ingredients" :key="i" class="list-row">
          <input v-model="form.ingredients[i]" type="text" placeholder="1 cup flour" />
          <button type="button" @click="removeIngredient(i)">Remove</button>
        </div>
        <button type="button" @click="addIngredient">+ Add ingredient</button>
      </fieldset>

      <fieldset>
        <legend>Steps</legend>
        <div v-for="(_, i) in form.steps" :key="i" class="list-row">
          <input v-model="form.steps[i]" type="text" placeholder="Preheat the oven…" />
          <button type="button" @click="removeStep(i)">Remove</button>
        </div>
        <button type="button" @click="addStep">+ Add step</button>
      </fieldset>

      <p v-if="saveError" class="field-error">Could not save: {{ saveError }}</p>
      <button type="submit" class="primary" :disabled="!isValid || saving">
        {{ saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create recipe' }}
      </button>
    </form>
  </section>
</template>

<style scoped>
  .editor form {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    max-width: 560px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
  }
  input,
  textarea {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    font: inherit;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
  }
  .list-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .list-row input {
    flex: 1;
  }
  .field-error {
    color: #a3241a;
    font-size: 0.8rem;
  }
  button.primary {
    align-self: flex-start;
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.6rem 1.3rem;
    border-radius: 6px;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
