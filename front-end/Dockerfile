FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html login.html /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY data /usr/share/nginx/html/data
COPY pages /usr/share/nginx/html/pages

EXPOSE 80
