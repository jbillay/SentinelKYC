import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'flag-icons/css/flag-icons.min.css'
import './styles/tokens.css'
import './styles/components.css'
import App from './App.vue'
import router from './router/index.js'
import { installApiClient, setOn401 } from './lib/api.js'

// Wrap window.fetch (credentials + CSRF + 401 handling) before anything calls it.
installApiClient()
setOn401(() => {
  if (router.currentRoute.value.name !== 'signin') {
    router.push({ name: 'signin', query: { redirect: router.currentRoute.value.fullPath } })
  }
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
