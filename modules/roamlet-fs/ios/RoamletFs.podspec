Pod::Spec.new do |s|
  s.name           = 'RoamletFs'
  s.version        = '0.1.0'
  s.summary        = 'Lasting folder access, file coordination, and safe in-place replacement'
  s.description    = 'Lasting folder access, file coordination, and safe in-place replacement'
  s.license        = 'MIT'
  s.author         = 'Roamlet'
  s.homepage       = 'https://github.com/masonfox/roamlet'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/masonfox/roamlet.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.swift'
  # The SwiftPM package around Core/ exists only to run the tests.
  s.exclude_files = 'Package.swift', 'Tests/**/*', '.build/**/*'
end
